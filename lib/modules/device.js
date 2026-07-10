/* ------------------------------------------------------------------
 * node-onvif - device.js
 *
 * Copyright (c) 2016-2018, Futomi Hatano, All rights reserved.
 * Released under the MIT license
 * Date: 2018-08-13
 * ---------------------------------------------------------------- */
'use strict';
// const ffmpeg = require('fluent-ffmpeg');
const { spawn } = require('child_process');

const mCrypto = require('crypto');
const mUrl = require('url');
const mUtil = require('util');
const mEventEmitter = require('events').EventEmitter;
const _ = require('lodash');

const mOnvifServiceDevice = require('./service-device.js');
const mOnvifServiceMedia = require('./service-media.js');
const mOnvifServicePtz = require('./service-ptz.js');
const mOnvifServiceEvents = require('./service-events.js');
const mOnvifServiceImaging = require('./service-imaging.js');
const mOnvifHttpAuth = require('./http-auth.js');
const mOnvifSoap = require('./soap.js');

// Many cameras drop sockets when hit with too many parallel connections,
// so per-profile SOAP work is capped at this concurrency.
const CAPABILITIES_CONCURRENCY = 2;

function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = () => {
    const index = nextIndex++;
    if (index >= items.length) return Promise.resolve();
    return Promise.resolve()
      .then(() => fn(items[index], index))
      .then((result) => {
        results[index] = result;
        return worker();
      });
  };
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(worker());
  }
  return Promise.all(workers).then(() => results);
}

/* ------------------------------------------------------------------
 * Constructor: OnvifDevice(params)
 * - params:
 *    - address : IP address of the targeted device
 *                (Required if the `xaddr` is not specified)
 *    - xaddr   : URL of the entry point for the device management service
 *                (Required if the `address' is not specified)
 *                If the `xaddr` is specified, the `address` is ignored.
 *    - user  : User name (Optional)
 *    - pass  : Password (Optional)
 * ---------------------------------------------------------------- */
function OnvifDevice(params) {
  if (!params || typeof params !== 'object') {
    throw new Error('The parameter was invalid.');
  }

  this.address = '';
  this.xaddr = '';
  this.user = '';
  this.pass = '';
  this.port = params.port || 80;
  this.protocol = params.protocol || 'http:';
  this.keepAddr = false;
  this.lastResponse = null; // for debug
  this.nonce = '';

  if ('xaddr' in params && typeof params['xaddr'] === 'string') {
    this.xaddr = params['xaddr'];
    let ourl = mUrl.parse(this.xaddr);
    this.address = ourl.hostname;
  } else if ('address' in params && typeof params['address'] === 'string') {
    this.keepAddr = true;
    this.address = params['address'];
    this.xaddr = 'http://' + this.address + '/onvif/device_service';
  } else {
    throw new Error('The parameter was invalid.');
  }
  if ('user' in params && typeof params['user'] === 'string') {
    this.user = params['user'] || '';
  }
  if ('pass' in params && typeof params['pass'] === 'string') {
    this.pass = params['pass'] || '';
  }

  this.oxaddr = mUrl.parse(this.xaddr);
  if (this.user) {
    this.oxaddr.auth = this.user + ':' + this.pass;
  }

  this.time_diff = 0;

  this.information = null;
  this.services = {
    device: new mOnvifServiceDevice({
      xaddr: this.xaddr,
      user: this.user,
      pass: this.pass,
      port: this.port,
      protocol: this.protocol,
    }),
    events: null,
    imaging: null,
    media: null,
    ptz: null,
  };
  this.profile_list = [];

  this.current_profile = null;
  this.ptz_profile = null;
  this.ptz_moving = false;

  mEventEmitter.call(this);
}
mUtil.inherits(OnvifDevice, mEventEmitter);

OnvifDevice.prototype._isValidCallback = function (callback) {
  return callback && typeof callback === 'function' ? true : false;
};

OnvifDevice.prototype._execCallback = function (callback, arg1, arg2) {
  if (this._isValidCallback(callback)) {
    callback(arg1, arg2);
  }
};

/* ------------------------------------------------------------------
 * Method: getInformation()
 * ---------------------------------------------------------------- */
OnvifDevice.prototype.getInformation = function () {
  let o = this.information;
  if (o) {
    return JSON.parse(JSON.stringify(o));
  } else {
    return null;
  }
};

/* ------------------------------------------------------------------
 * Method: getCurrentProfile()
 * ---------------------------------------------------------------- */
OnvifDevice.prototype.getCurrentProfile = function () {
  let o = this.current_profile;
  if (o) {
    return JSON.parse(JSON.stringify(o));
  } else {
    return null;
  }
};

/* ------------------------------------------------------------------
 * Method: getProfileList()
 * ---------------------------------------------------------------- */
OnvifDevice.prototype.getProfileList = function () {
  return JSON.parse(JSON.stringify(this.profile_list));
};

/* ------------------------------------------------------------------
 * Method: getPtzProfileToken()
 * Returns the token of a media profile that has a PTZConfiguration
 * bound to it. Some cameras (e.g. LTV domes) expose PTZ only on a
 * non-default profile, so PTZ commands sent against current_profile
 * are rejected with "requested PTZConfiguration does not exist".
 * Falls back to current_profile when no PTZ-capable profile is known,
 * preserving behavior for cameras that bind PTZ to the first profile.
 * ---------------------------------------------------------------- */
OnvifDevice.prototype.getPtzProfileToken = function () {
  if (this.ptz_profile) {
    return this.ptz_profile['token'];
  }
  return this.current_profile ? this.current_profile['token'] : null;
};

/* ------------------------------------------------------------------
 * Method: changeProfile(index|token)
 * ---------------------------------------------------------------- */
OnvifDevice.prototype.changeProfile = function (index) {
  if (typeof index === 'number' && index >= 0 && index % 1 === 0) {
    let p = this.profile_list[index];
    if (p) {
      this.current_profile = p;
      return this.getCurrentProfile();
    } else {
      return null;
    }
  } else if (typeof index === 'string' && index.length > 0) {
    let new_profile = null;
    for (let i = 0; i < this.profile_list.length; i++) {
      if (this.profile_list[i]['token'] === index) {
        new_profile = this.profile_list[i];
        break;
      }
    }
    if (new_profile) {
      this.current_profile = new_profile;
      return this.getCurrentProfile();
    } else {
      return null;
    }
  } else {
    return null;
  }
};

/* ------------------------------------------------------------------
 * Method: restrictToVideoSource(videoSourceToken)
 * Scopes the device to a single video source (lens) of a multi-lens
 * camera: current_profile becomes the lens's first profile and
 * ptz_profile becomes the lens's first PTZ-capable profile (or null,
 * so getPtzProfileToken() falls back to the lens's own token and a
 * PTZ-less lens can never drive another lens's PTZ). profile_list is
 * left untouched so global profile indices stay valid for encoder and
 * imaging calls. Returns false without mutating state when no profile
 * matches (e.g. Media2 fallback profiles carry no video source info).
 * ---------------------------------------------------------------- */
OnvifDevice.prototype.restrictToVideoSource = function (videoSourceToken) {
  if (!videoSourceToken) return false;

  let firstProfile = null;
  let firstPtzProfile = null;
  for (let i = 0; i < this.profile_list.length; i++) {
    const p = this.profile_list[i];
    const source = p['video'] && p['video']['source'];
    if (!source || source['token'] !== videoSourceToken) continue;
    if (!firstProfile) firstProfile = p;
    if (!firstPtzProfile && p['hasPtz']) firstPtzProfile = p;
  }

  if (!firstProfile) return false;

  this.current_profile = firstProfile;
  this.ptz_profile = firstPtzProfile || null;
  return true;
};

/* ------------------------------------------------------------------
 * Method: getDeviceInfo()
 * ---------------------------------------------------------------- */

OnvifDevice.prototype.getDeviceInfo = function () {
  return this.information;
};

function processStreamUrl(url, options) {
  if (options.pass) {
    const encodedPassword = options.pass
      .split('')
      .map((el) => escape(el))
      .join('');
    let streamUrl = url.split('//');
    streamUrl = `${streamUrl[0]}//${options.user}:${encodedPassword}@${streamUrl[1]}`;
    return streamUrl;
  }
  return url;
}

// function checkStreamCodec(url, options) {
//   return new Promise((resolve, reject) => {
//     const authUrl = processStreamUrl(url, options);
//     ffmpeg.ffprobe(authUrl, (err, metadata) => {
//       if (err) {
//         reject(err);
//       } else {
//         const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
//         resolve(Boolean(videoStream));
//       }
//     });
//   });
// }

/* ------------------------------------------------------------------
 * Method: getStreamConfigs()
 * ---------------------------------------------------------------- */
OnvifDevice.prototype.getStreamConfigs = async function (options) {
  if (!this.current_profile) return [];

  const seenVideoSources = {};

  const streams = this.profile_list.map((profile, index) => {
    const streamData = {};
    let urlIpAddress = null;
    const encoder = profile['video']['encoder'] || {};
    const videoSource = profile['video'] && profile['video']['source'];
    streamData.url = profile['stream']['rtsp'] || '';

    const ipAddressOrHost = new URL(this.xaddr).hostname;
    const urlIpAddressArr = streamData.url.match(/\/\/([^:/]+)/);
    if (urlIpAddressArr && urlIpAddressArr.length) {
      urlIpAddress = urlIpAddressArr[1];
    }

    if (urlIpAddress) {
      streamData.url = streamData.url.replace(urlIpAddress, ipAddressOrHost);
    }

    // First profile of each video source (lens) is its main stream. For
    // single-source and Media2-fallback devices (one shared key) this
    // degenerates to the previous `index === 0` behavior.
    const sourceKey = (videoSource && videoSource['token']) || '__default__';
    streamData.isMainStream = !seenVideoSources[sourceKey];
    seenVideoSources[sourceKey] = true;

    streamData.videoSourceToken = (videoSource && videoSource['token']) || null;
    streamData.profileToken = profile['token'];
    streamData.hasPtz = !!profile['hasPtz'];
    streamData.fps = encoder.framerate || null;
    streamData.resolution = encoder.resolution ? `${encoder.resolution.width}x${encoder.resolution.height}` : null;

    return streamData;
  });

  if (!streams.length) return [];

  let configs = _.uniqBy(streams, 'url').filter((stream) => stream.url && !stream.url.includes('jpeg'));
  return configs;
};

/* ------------------------------------------------------------------
 * Method: fetchSnapshot()
 * ---------------------------------------------------------------- */
OnvifDevice.prototype.fetchSnapshot = function (callback) {
  let promise = new Promise((resolve, reject) => {
    if (!this.current_profile) {
      reject(new Error('No media profile is selected.'));
      return;
    }
    if (!this.current_profile['snapshot']) {
      reject(new Error('The device does not support snapshot or you have not authorized by the device.'));
      return;
    }
    let ourl = mUrl.parse(this.current_profile['snapshot']);
    let options = {
      protocol: ourl.protocol,
      auth: this.user + ':' + this.pass,
      hostname: ourl.hostname,
      port: ourl.port || 80,
      path: ourl.path,
      method: 'GET',
    };
    let req = mOnvifHttpAuth.request(options, (res) => {
      let buffer_list = [];
      res.on('data', (buf) => {
        buffer_list.push(buf);
      });
      res.on('end', () => {
        if (res.statusCode === 200) {
          let buffer = Buffer.concat(buffer_list);
          let ct = res.headers['content-type'];
          if (!ct) {
            // workaround for DBPOWER
            ct = 'image/jpeg';
          }
          if (ct.match(/image\//)) {
            resolve({ headers: res.headers, body: buffer });
          } else if (ct.match(/^text\//)) {
            reject(new Error(buffer.toString()));
          } else {
            reject(new Error('Unexpected data: ' + ct));
          }
        } else {
          reject(new Error(res.statusCode + ' ' + res.statusMessage));
        }
      });
      req.on('error', (error) => {
        reject(error);
      });
    });
    req.on('error', (error) => {
      reject(error);
    });
    req.end();
  });
  if (this._isValidCallback(callback)) {
    promise
      .then((res) => {
        callback(null, res);
      })
      .catch((error) => {
        callback(error);
      });
  } else {
    return promise;
  }
};

/* ------------------------------------------------------------------
 * Method: ptzMove(params[, callback])
 * - params:
 *   - speed:
 *     - x     | Float   | required | speed for pan (in the range of -1.0 to 1.0)
 *     - y     | Float   | required | speed for tilt (in the range of -1.0 to 1.0)
 *     - z     | Float   | required | speed for zoom (in the range of -1.0 to 1.0)
 *   - timeout | Integer | optional | seconds (Default 1)
 * ---------------------------------------------------------------- */
OnvifDevice.prototype.ptzMove = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    if (!this.current_profile) {
      reject(new Error('No media profile is selected.'));
      return;
    }
    if (!this.services['ptz']) {
      reject(new Error('The device does not support PTZ.'));
      return;
    }

    let speed = params['speed'];
    if (!speed) {
      speed = {};
    }
    let x = speed['x'] || 0;
    let y = speed['y'] || 0;
    let z = speed['z'] || 0;

    let timeout = params['timeout'];
    if (!timeout || typeof timeout !== 'number') {
      timeout = 1;
    }
    let p = {
      ProfileToken: this.getPtzProfileToken(),
      Velocity: { x: x, y: y, z: z },
      Timeout: timeout,
    };

    this.ptz_moving = true;
    this.services['ptz']
      .continuousMove(p, this.information)
      .then(() => {
        resolve();
      })
      .catch((error) => {
        reject(error);
      });
  });
  if (this._isValidCallback(callback)) {
    promise
      .then(() => {
        callback(null);
      })
      .catch((error) => {
        callback(error);
      });
  } else {
    return promise;
  }
};

/* ------------------------------------------------------------------
 * Method: ptzStop([callback])
 * ---------------------------------------------------------------- */
OnvifDevice.prototype.ptzStop = function (callback) {
  let promise = new Promise((resolve, reject) => {
    if (!this.current_profile) {
      reject(new Error('No media profile is selected.'));
      return;
    }
    if (!this.services['ptz']) {
      reject(new Error('The device does not support PTZ.'));
      return;
    }
    this.ptz_moving = false;
    let p = {
      ProfileToken: this.getPtzProfileToken(),
      PanTilt: true,
      Zoom: true,
    };
    this.services['ptz']
      .stop(p, this.information)
      .then((result) => {
        resolve(result);
      })
      .catch((error) => {
        reject(error);
      });
  });
  if (this._isValidCallback(callback)) {
    promise
      .then((res) => {
        callback(null, res);
      })
      .catch((error) => {
        callback(error);
      });
  } else {
    return promise;
  }
};

/* ------------------------------------------------------------------
 * Method: setAuth(user, pass)
 * ---------------------------------------------------------------- */
OnvifDevice.prototype.setAuth = function (user, pass) {
  this.user = user || '';
  this.pass = pass || '';
  if (this.user) {
    this.oxaddr.auth = this.user + ':' + this.pass;
  }
  for (let k in this.services) {
    let s = this.services[k];
    if (s) {
      this.services[k].setAuth(user, pass);
    }
  }
};

/* ------------------------------------------------------------------
 * Method: init([callback])
 * ---------------------------------------------------------------- */
OnvifDevice.prototype.init = function (callback) {
  let promise = new Promise((resolve, reject) => {
    this._getSystemDateAndTime()
      .then(() => {
        return this._getCapabilities();
      })
      .then(() => {
        return this._getDeviceInformation();
      })
      .then(() => {
        return this._mediaGetProfiles();
      })
      .then(() => {
        return this._mediaGetStreamURI();
      })
      // .then(() => {
      //   return this._mediaGetSnapshotUri();
      // })
      .then(() => {
        let info = this.getInformation();
        // console.log('Device information ==> ', info);
        resolve(info);
      })
      .catch((error) => {
        // If media ver10 GetProfiles failed, try Media2 (ver20) fallback
        console.log('[ONVIF] Media ver10 failed, attempting Media2 (ver20) fallback...');
        this.profile_list = [];
        this.current_profile = null;
        this.ptz_profile = null;
        this._getServices()
          .then(() => {
            return this._media2GetProfiles();
          })
          .then(() => {
            return this._media2GetStreamURI();
          })
          .then(() => {
            let info = this.getInformation();
            resolve(info);
          })
          .catch((error2) => {
            reject(error);
          });
      });
  });
  if (this._isValidCallback(callback)) {
    promise
      .then((info) => {
        callback(null, info);
      })
      .catch((error) => {
        callback(error);
      });
  } else {
    return promise;
  }
};

// GetSystemDateAndTime (Access Class: PRE_AUTH)
OnvifDevice.prototype._getSystemDateAndTime = function () {
  let promise = new Promise((resolve, reject) => {
    this.services.device.getSystemDateAndTime((error, result) => {
      // Ignore the error becase some devices do not support
      // the GetSystemDateAndTime command and the error does
      // not cause any trouble.
      if (!error) {
        this.time_diff = this.services.device.getTimeDiff();
      }
      resolve();
    });
  });
  return promise;
};

// GetCapabilities (Access Class: PRE_AUTH)
OnvifDevice.prototype._getCapabilities = function () {
  let promise = new Promise((resolve, reject) => {
    this.services.device.getCapabilities((error, result) => {
      this.lastResponse = result;
      if (error) {
        reject(new Error('Failed to initialize the device: ' + error.toString()));
        return;
      }
      let c = result['data']['GetCapabilitiesResponse']['Capabilities'];
      if (!c) {
        reject(new Error('Failed to initialize the device: No capabilities were found.'));
        return;
      }
      let events = c['Events'];
      if (events && events['XAddr']) {
        this.services.events = new mOnvifServiceEvents({
          // xaddr: this._getXaddr(events["XAddr"]),
          xaddr: this.xaddr,
          time_diff: this.time_diff,
          user: this.user,
          pass: this.pass,
          port: this.port,
          protocol: this.protocol,
        });
      }
      let imaging = c['Imaging'];
      if (imaging && imaging['XAddr']) {
        this.services.imaging = new mOnvifServiceImaging({
          // xaddr: this._getXaddr(imaging["XAddr"]),
          xaddr: this.xaddr,
          time_diff: this.time_diff,
          user: this.user,
          pass: this.pass,
          port: this.port,
          protocol: this.protocol,
        });
      }
      let media = c['Media'];
      if (media && media['XAddr']) {
        this.services.media = new mOnvifServiceMedia({
          // xaddr: this._getXaddr(media["XAddr"]),
          xaddr: this.xaddr,
          time_diff: this.time_diff,
          user: this.user,
          pass: this.pass,
          port: this.port,
          protocol: this.protocol,
        });
      }
      let ptz = c['PTZ'];
      if (ptz && ptz['XAddr']) {
        this.services.ptz = new mOnvifServicePtz({
          // xaddr: this._getXaddr(ptz["XAddr"]),
          xaddr: this.xaddr,
          time_diff: this.time_diff,
          user: this.user,
          pass: this.pass,
          port: this.port,
          protocol: this.protocol,
        });
      }
      resolve();
    });
  });
  return promise;
};

// GetDeviceInformation (Access Class: READ_SYSTEM)
OnvifDevice.prototype._getDeviceInformation = function () {
  let promise = new Promise((resolve, reject) => {
    this.services.device.getDeviceInformation((error, result) => {
      if (error) {
        reject(new Error('Failed to initialize the device: ' + error.toString()));
      } else {
        this.information = result['data']['GetDeviceInformationResponse'];
        resolve();
      }
    });
  });
  return promise;
};

// Media::GetProfiles (Access Class: READ_MEDIA)
OnvifDevice.prototype._mediaGetProfiles = function () {
  let promise = new Promise((resolve, reject) => {
    this.services.media.getProfiles(this.information, (error, result) => {
      this.lastResponse = result;

      if (error) {
        reject(new Error('Failed to initialize the device: ' + error.toString()));
        return;
      }
      let profiles = result['data']['GetProfilesResponse']['Profiles'];

      if (!profiles) {
        reject(new Error('Failed to initialize the device: The targeted device does not any media profiles.'));
        return;
      }
      profiles = [].concat(profiles); // in case profiles is not a list, then forEach below will report an error

      profiles.forEach((p) => {
        let profile = {
          token: p['$']['token'],
          name: p['Name'],
          snapshot: '',
          stream: {
            udp: '',
            http: '',
            rtsp: '',
          },
          video: {
            source: null,
            encoder: null,
          },
          audio: {
            source: null,
            encoder: null,
          },
          ptz: {
            range: {
              x: {
                min: 0,
                max: 0,
              },
              y: {
                min: 0,
                max: 0,
              },
              z: {
                min: 0,
                max: 0,
              },
            },
          },
        };

        if (p['VideoSourceConfiguration']) {
          profile['video']['source'] = {
            token: p['VideoSourceConfiguration']['$']['token'],
            // Token of the underlying VideoSource (not the configuration) —
            // this is what the imaging service commands expect.
            sourceToken: p['VideoSourceConfiguration']['SourceToken'],
            name: p['VideoSourceConfiguration']['Name'],
            bounds: {
              width: parseInt(p['VideoSourceConfiguration']['Bounds']['$']['width'], 10),
              height: parseInt(p['VideoSourceConfiguration']['Bounds']['$']['height'], 10),
              x: parseInt(p['VideoSourceConfiguration']['Bounds']['$']['x'], 10),
              y: parseInt(p['VideoSourceConfiguration']['Bounds']['$']['y'], 10),
            },
          };
        }
        if (p['VideoEncoderConfiguration'] && p['VideoEncoderConfiguration']['Resolution']) {
          profile['video']['encoder'] = {
            token: p['VideoEncoderConfiguration']['$']['token'],
            name: p['VideoEncoderConfiguration']['Name'],
            resolution: {
              width: parseInt(p['VideoEncoderConfiguration']['Resolution']['Width'], 10),
              height: parseInt(p['VideoEncoderConfiguration']['Resolution']['Height'], 10),
            },
            quality: parseInt(p['VideoEncoderConfiguration']['Quality'], 10),
            framerate: parseInt(p['VideoEncoderConfiguration']['RateControl']['FrameRateLimit'], 10),
            bitrate: parseInt(p['VideoEncoderConfiguration']['RateControl']['BitrateLimit'], 10),
            encoding: p['VideoEncoderConfiguration']['Encoding'],
          };
        }
        if (p['AudioSourceConfiguration']) {
          profile['audio']['source'] = {
            token: p['AudioSourceConfiguration']['$']['token'],
            name: p['AudioSourceConfiguration']['Name'],
          };
        }
        if (p['AudioEncoderConfiguration']) {
          profile['audio']['encoder'] = {
            token: '$' in p['AudioEncoderConfiguration'] ? p['AudioEncoderConfiguration']['$']['token'] : '',
            name: p['AudioEncoderConfiguration']['Name'],
            bitrate: parseInt(p['AudioEncoderConfiguration']['Bitrate'], 10),
            samplerate: parseInt(p['AudioEncoderConfiguration']['SampleRate'], 10),
            encoding: p['AudioEncoderConfiguration']['Encoding'],
          };
        }
        if (p['PTZConfiguration']) {
          profile['hasPtz'] = true;
          try {
            profile['ptz']['configToken'] = p['PTZConfiguration']['$'] && p['PTZConfiguration']['$']['token'];
          } catch (e) {}
          try {
            let r = p['PTZConfiguration']['PanTiltLimits']['Range'];
            let xr = r['XRange'];
            let x = profile['ptz']['range']['x'];
            x['min'] = parseFloat(xr['Min']);
            x['max'] = parseFloat(xr['Max']);
          } catch (e) {}
          try {
            let r = p['PTZConfiguration']['PanTiltLimits']['Range'];
            let yr = r['YRange'];
            let y = profile['ptz']['range']['y'];
            y['min'] = parseFloat(yr['Min']);
            y['max'] = parseFloat(yr['Max']);
          } catch (e) {}
          try {
            let r = p['PTZConfiguration']['ZoomLimits']['Range'];
            let zr = r['XRange'];
            let z = profile['ptz']['range']['z'];
            z['min'] = parseFloat(zr['Min']);
            z['max'] = parseFloat(zr['Max']);
          } catch (e) {}
        }

        this.profile_list.push(profile);
        if (!this.current_profile) {
          this.current_profile = profile;
        }
        if (!this.ptz_profile && profile['hasPtz']) {
          this.ptz_profile = profile;
        }
      });
      resolve();
    });
  });
  return promise;
};

// Media::GetStreamURI (Access Class: READ_MEDIA)
OnvifDevice.prototype._mediaGetStreamURI = function () {
  // Only RTSP is ever consumed (getStreamConfigs); skipping UDP/HTTP saves
  // two SOAP round trips per profile.
  let protocol_list = ['RTSP'];
  let promise = new Promise((resolve, reject) => {
    let profile_index = 0;
    let protocol_index = 0;
    let getStreamUri = () => {
      let profile = this.profile_list[profile_index];
      if (profile) {
        let protocol = protocol_list[protocol_index];
        if (protocol) {
          let token = profile['token'];
          let params = {
            ProfileToken: token,
            Protocol: protocol,
          };

          this.services.media.getStreamUri(params, this.information, (error, result) => {
            this.lastResponse = result;
            if (!error) {
              let uri = result['data']['GetStreamUriResponse']['MediaUri']['Uri'];
              uri = this._getUri(uri);
              this.profile_list[profile_index]['stream'][protocol.toLowerCase()] = uri;
            }
            protocol_index++;
            getStreamUri();
          });
        } else {
          profile_index++;
          protocol_index = 0;
          getStreamUri();
        }
      } else {
        resolve();
        return;
      }
    };
    getStreamUri();
  });
  return promise;
};

// GetServices - discovers Media2 XAddr
OnvifDevice.prototype._getServices = function () {
  return new Promise((resolve, reject) => {
    let soap_body = '<tds:GetServices><tds:IncludeCapability>false</tds:IncludeCapability></tds:GetServices>';
    let soap = this.services.device._createRequestSoap(soap_body);

    mOnvifSoap.requestCommand(this.services.device.getRequestParams(), 'GetServices', soap, this.information)
      .then((result) => {
        let services = result['data']['GetServicesResponse']['Service'];
        if (services) {
          services = [].concat(services);
          services.forEach((svc) => {
            if (svc['Namespace'] === 'http://www.onvif.org/ver20/media/wsdl') {
              this.media2Xaddr = this._getXaddr(svc['XAddr']);
              console.log('[ONVIF] Found Media2 service at:', this.media2Xaddr);
            }
          });
        }
        resolve();
      })
      .catch((error) => {
        reject(new Error('GetServices failed: ' + error.toString()));
      });
  });
};

// Media2::GetProfiles (ver20 fallback)
OnvifDevice.prototype._media2GetProfiles = function () {
  return new Promise((resolve, reject) => {
    let media2Xaddr = this.media2Xaddr;
    if (!media2Xaddr) {
      reject(new Error('Media2 service not available'));
      return;
    }

    let soap_body = '<tr2:GetProfiles/>';
    let soap = mOnvifSoap.createRequestSoap({
      body: soap_body,
      xmlns: [
        'xmlns:tr2="http://www.onvif.org/ver20/media/wsdl"',
        'xmlns:tt="http://www.onvif.org/ver10/schema"',
      ],
      diff: this.time_diff,
      user: this.user,
      pass: this.pass,
    });

    let oxaddr = Object.assign({}, mUrl.parse(media2Xaddr), {
      port: this.port,
      protocol: this.protocol,
    });

    mOnvifSoap.requestCommand(oxaddr, 'GetProfiles', soap, this.information)
      .then((result) => {
        let profiles = result['data']['GetProfilesResponse']['Profiles'];
        if (!profiles) {
          reject(new Error('Media2: No profiles found'));
          return;
        }
        profiles = [].concat(profiles);

        profiles.forEach((p) => {
          let profile = {
            token: p['$'] ? p['$']['token'] : (p['token'] || ''),
            name: p['Name'] || '',
            snapshot: '',
            stream: { udp: '', http: '', rtsp: '' },
            video: { source: null, encoder: null },
            audio: { source: null, encoder: null },
            ptz: { range: { x: { min: 0, max: 0 }, y: { min: 0, max: 0 }, z: { min: 0, max: 0 } } },
          };
          this.profile_list.push(profile);
          if (!this.current_profile) {
            this.current_profile = profile;
          }
        });
        this.useMedia2 = true;
        resolve();
      })
      .catch((error) => {
        reject(new Error('Media2 GetProfiles failed: ' + error.toString()));
      });
  });
};

// Media2::GetStreamUri (ver20 fallback)
OnvifDevice.prototype._media2GetStreamURI = function () {
  return new Promise((resolve, reject) => {
    let media2Xaddr = this.media2Xaddr;
    let profile_index = 0;

    let getStreamUri = () => {
      let profile = this.profile_list[profile_index];
      if (!profile) {
        resolve();
        return;
      }

      let soap_body = '';
      soap_body += '<tr2:GetStreamUri>';
      soap_body += '<tr2:Protocol>RTSP</tr2:Protocol>';
      soap_body += '<tr2:ProfileToken>' + profile['token'] + '</tr2:ProfileToken>';
      soap_body += '</tr2:GetStreamUri>';

      let soap = this.services.device._createRequestSoap.call({
        name_space_attr_list: [
          'xmlns:tr2="http://www.onvif.org/ver20/media/wsdl"',
          'xmlns:tt="http://www.onvif.org/ver10/schema"',
        ],
        time_diff: this.time_diff,
        user: this.user,
        pass: this.pass,
      }, soap_body);

      let oxaddr = Object.assign({}, mUrl.parse(media2Xaddr), {
        port: this.port,
        protocol: this.protocol,
      });

      mOnvifSoap.requestCommand(oxaddr, 'GetStreamUri', soap, this.information)
        .then((result) => {
          let uri = result['data']['GetStreamUriResponse']['Uri'];
          if (uri) {
            uri = this._getUri(uri);
            profile['stream']['rtsp'] = uri;
          }
          profile_index++;
          getStreamUri();
        })
        .catch(() => {
          profile_index++;
          getStreamUri();
        });
    };
    getStreamUri();
  });
};

// Media::GetSnapshotUri (Access Class: READ_MEDIA)
OnvifDevice.prototype._mediaGetSnapshotUri = function () {
  let promise = new Promise((resolve, reject) => {
    let profile_index = 0;
    let getSnapshotUri = () => {
      let profile = this.profile_list[profile_index];
      if (profile) {
        let params = { ProfileToken: profile['token'] };
        this.services.media.getSnapshotUri(params, (error, result) => {
          this.lastResponse = result;
          if (!error) {
            try {
              let snapshotUri = result['data']['GetSnapshotUriResponse']['MediaUri']['Uri'];
              snapshotUri = this._getSnapshotUri(snapshotUri);
              profile['snapshot'] = snapshotUri;
            } catch (e) {
              console.log(e);
            }
          }
          profile_index++;
          getSnapshotUri();
        });
      } else {
        resolve();
      }
    };
    getSnapshotUri();
  });
  return promise;
};

OnvifDevice.prototype._getXaddr = function (directXaddr) {
  if (!this.keepAddr) return directXaddr;
  const path = mUrl.parse(directXaddr).path;
  return 'http://' + this.address + path;
};

OnvifDevice.prototype._getUri = function (directUri) {
  if (typeof directUri === 'object' && directUri['_']) {
    directUri = directUri['_'];
  }
  if (!this.keepAddr) return directUri;
  const base = mUrl.parse('http://' + this.address);
  const parts = mUrl.parse(directUri);
  const newParts = {
    host: base.host,
    pathname: base.pathname + parts.pathname,
  };
  const newUri = mUrl.format(newParts);

  return newUri;
};

OnvifDevice.prototype._getSnapshotUri = function (directUri) {
  if (typeof directUri === 'object' && directUri['_']) {
    directUri = directUri['_'];
  }
  if (!this.keepAddr) return directUri;
  const base = mUrl.parse('http://' + this.address);
  const parts = mUrl.parse(directUri);
  const newParts = {
    protocol: parts.protocol,
    host: base.host,
    pathname: base.pathname + parts.pathname,
  };
  const newUri = mUrl.format(newParts);
  return newUri;
};

module.exports = OnvifDevice;

/* ------------------------------------------------------------------
 * Method: getImagingSettings(profileIndex, [callback])
 * ---------------------------------------------------------------- */
OnvifDevice.prototype.getImagingSettings = function (profileIndex, callback) {
  // Handle case where profileIndex is omitted and callback is first parameter
  if (typeof profileIndex === 'function' && callback === undefined) {
    callback = profileIndex;
    profileIndex = 0; // Default to first profile
  }

  // Handle case where profileIndex is undefined
  if (profileIndex === undefined) {
    profileIndex = 0; // Default to first profile
  }

  let promise = new Promise((resolve, reject) => {
    // Check if profileIndex is valid
    if (typeof profileIndex !== 'number' || profileIndex < 0 || profileIndex >= this.profile_list.length) {
      reject(new Error(`Invalid profile index: ${profileIndex}. Must be between 0 and ${this.profile_list.length - 1}`));
      return;
    }

    if (!this.services['imaging']) {
      reject(new Error('The device does not support imaging.'));
      return;
    }

    this._getProfileTokens(profileIndex, 'source')
      .then((tokens) => {
        if (!tokens.videoSourceToken) {
          throw new Error(`No video source configuration found for profile ${profileIndex}`);
        }

        return this.services['imaging'].getImagingSettings({
          VideoSourceToken: tokens.videoSourceToken,
        });
      })
      .then((result) => {
        resolve(result);
      })
      .catch((error) => {
        reject(error);
      });
  });

  if (this._isValidCallback(callback)) {
    promise
      .then((result) => {
        callback(null, result);
      })
      .catch((error) => {
        callback(error);
      });
  } else {
    return promise;
  }
};

/* ------------------------------------------------------------------
 * Method: setImagingSettings(params, profileIndex, [callback])
 * ---------------------------------------------------------------- */
OnvifDevice.prototype.setImagingSettings = function (params, profileIndex, callback) {
  // Handle case where profileIndex is omitted and callback is second parameter
  if (typeof profileIndex === 'function' && callback === undefined) {
    callback = profileIndex;
    profileIndex = 0; // Default to first profile
  }

  // Handle case where profileIndex is undefined
  if (profileIndex === undefined) {
    profileIndex = 0; // Default to first profile
  }

  let promise = new Promise((resolve, reject) => {
    if (!params || typeof params !== 'object') {
      reject(new Error('The first argument must be an object.'));
      return;
    }

    console.log('\n[ONVIF] Setting imaging settings:', JSON.stringify(params, null, 2));

    // Check if profileIndex is valid
    if (typeof profileIndex !== 'number' || profileIndex < 0 || profileIndex >= this.profile_list.length) {
      reject(new Error(`Invalid profile index: ${profileIndex}. Must be between 0 and ${this.profile_list.length - 1}`));
      return;
    }

    if (!this.services['imaging']) {
      reject(new Error('The device does not support imaging.'));
      return;
    }

    this._getProfileTokens(profileIndex, 'source')
      .then((tokens) => {
        if (!tokens.videoSourceToken) {
          throw new Error(`No video source configuration found for profile ${profileIndex}`);
        }

        let p = JSON.parse(JSON.stringify(params));
        p['VideoSourceToken'] = tokens.videoSourceToken;

        console.log('\n[ONVIF] Sending imaging settings to camera with source token:', tokens.videoSourceToken);
        return this.services['imaging'].setImagingSettings(p);
      })
      .then((result) => {
        console.log('\n[ONVIF] Imaging settings updated successfully');
        resolve(result);
      })
      .catch((error) => {
        console.error('\n[ONVIF] Error updating imaging settings:', error.message);
        reject(error);
      });
  });

  if (this._isValidCallback(callback)) {
    promise
      .then((result) => {
        callback(null, result);
      })
      .catch((error) => {
        callback(error);
      });
  } else {
    return promise;
  }
};

/* ------------------------------------------------------------------
 * Method: getImagingOptions(profileIndex, [callback])
 * ---------------------------------------------------------------- */
OnvifDevice.prototype.getImagingOptions = function (profileIndex, callback) {
  // Handle case where profileIndex is omitted and callback is first parameter
  if (typeof profileIndex === 'function' && callback === undefined) {
    callback = profileIndex;
    profileIndex = 0; // Default to first profile
  }

  // Handle case where profileIndex is undefined
  if (profileIndex === undefined) {
    profileIndex = 0; // Default to first profile
  }

  let promise = new Promise((resolve, reject) => {
    // Check if profileIndex is valid
    if (typeof profileIndex !== 'number' || profileIndex < 0 || profileIndex >= this.profile_list.length) {
      reject(new Error(`Invalid profile index: ${profileIndex}. Must be between 0 and ${this.profile_list.length - 1}`));
      return;
    }

    if (!this.services['imaging']) {
      reject(new Error('The device does not support imaging.'));
      return;
    }

    this._getProfileTokens(profileIndex, 'source')
      .then((tokens) => {
        if (!tokens.videoSourceToken) {
          throw new Error(`No video source configuration found for profile ${profileIndex}`);
        }

        return this.services['imaging'].getOptions({
          VideoSourceToken: tokens.videoSourceToken,
        });
      })
      .then((result) => {
        resolve(result);
      })
      .catch((error) => {
        reject(error);
      });
  });

  if (this._isValidCallback(callback)) {
    promise
      .then((result) => {
        callback(null, result);
      })
      .catch((error) => {
        callback(error);
      });
  } else {
    return promise;
  }
};

/* ------------------------------------------------------------------
 * Method: getProfilesFromDevice()
 * Returns camera profile information using the official ONVIF npm module
 * but uses the current device's connection parameters
 * ---------------------------------------------------------------- */
OnvifDevice.prototype.getProfilesFromDevice = function () {
  // The official module's connect() is a full multi-request ONVIF handshake,
  // so the result is memoized per device instance.
  if (this._profilesFromDevicePromise) {
    return this._profilesFromDevicePromise;
  }

  // Require the official ONVIF npm module
  const onvif = require('onvif');

  this._profilesFromDevicePromise = new Promise((resolve, reject) => {
    // Create the camera object using this device's parameters
    const cam = new onvif.Cam({
      hostname: this.address || '',
      port: this.port || 80,
      username: this.user || '',
      password: this.pass || '',
      useSecure: this.protocol === 'https:',
    });

    // Connect to the camera
    cam.connect((err) => {
      if (err) {
        console.error('Error connecting to camera:', err);
        return reject(err);
      }

      // Return the profiles directly from the official module
      resolve(cam.profiles);
    });
  });

  this._profilesFromDevicePromise.catch(() => {
    this._profilesFromDevicePromise = null;
  });

  return this._profilesFromDevicePromise;
};

/* ------------------------------------------------------------------
 * Method: _getProfileTokens(profileIndex, required)
 * Resolves { profileToken, videoSourceToken, encoderToken } for a profile.
 * Uses profile_list built during init(); falls back to the official module
 * (memoized getProfilesFromDevice) only when profile_list lacks the token
 * kind named by `required` ('source' | 'encoder') — e.g. Media2 fallback
 * profiles, which carry no video info.
 * ---------------------------------------------------------------- */
OnvifDevice.prototype._getProfileTokens = function (profileIndex, required) {
  const listed = this.profile_list[profileIndex];
  const video = listed && listed['video'];
  const source = video && video['source'];
  const encoder = video && video['encoder'];
  const localSourceToken = source && (source['sourceToken'] !== null && source['sourceToken'] !== undefined ? source['sourceToken'] : null);
  const localTokens = {
    profileToken: listed && listed['token'],
    videoSourceToken: localSourceToken !== null ? String(localSourceToken) : null,
    encoderToken: encoder && encoder['token'] ? encoder['token'] : null,
  };

  const missingRequired =
    (required === 'source' && !localTokens.videoSourceToken) ||
    (required === 'encoder' && !localTokens.encoderToken);

  if (listed && !missingRequired && (source || encoder)) {
    return Promise.resolve(localTokens);
  }

  return this.getProfilesFromDevice().then((profiles) => {
    const profile = profiles[profileIndex] || profiles[0];
    if (!profile) {
      throw new Error('No profile found for index ' + profileIndex);
    }
    const vsc = profile.videoSourceConfiguration;
    const vec = profile.videoEncoderConfiguration;
    return {
      profileToken: profile.$ && profile.$.token,
      videoSourceToken: vsc && vsc.sourceToken !== null && vsc.sourceToken !== undefined ? String(vsc.sourceToken) : null,
      encoderToken: vec && vec.$ && vec.$.token ? vec.$.token : null,
    };
  });
};

/* ------------------------------------------------------------------
 * Method: getVideoEncoderConfiguration(profileIndex, [callback])
 * ---------------------------------------------------------------- */
OnvifDevice.prototype.getVideoEncoderConfiguration = function (profileIndex, callback) {
  // Handle case where profileIndex is omitted and callback is first parameter
  if (typeof profileIndex === 'function' && callback === undefined) {
    callback = profileIndex;
    profileIndex = 0; // Default to first profile
  }

  // Handle case where profileIndex is undefined
  if (profileIndex === undefined) {
    profileIndex = 0; // Default to first profile
  }

  let promise = new Promise((resolve, reject) => {
    // Check if profileIndex is valid
    if (typeof profileIndex !== 'number' || profileIndex < 0 || profileIndex >= this.profile_list.length) {
      reject(new Error(`Invalid profile index: ${profileIndex}. Must be between 0 and ${this.profile_list.length - 1}`));
      return;
    }

    if (!this.services['media']) {
      reject(new Error('The device does not support media service.'));
      return;
    }

    // The official module's profiles carry the full (camelCase) encoder
    // configuration shape consumers expect; getProfilesFromDevice is
    // memoized, so this costs at most one connect per device instance.
    this.getProfilesFromDevice()
      .then((profiles) => {
        // Get profile at requested profile index
        const profile = profiles[profileIndex] || profiles[0];

        if (!profile || !profile.videoEncoderConfiguration) {
          throw new Error(`No video encoder configuration found for profile ${profileIndex}`);
        }

        // Create a simple wrapper for the result to match the original format
        const result = {
          data: {
            GetVideoEncoderConfigurationResponse: {
              Configuration: profile.videoEncoderConfiguration,
            },
          },
        };

        resolve(result);
      })
      .catch((error) => {
        console.error('\n[ONVIF] Error getting encoder configuration:', error.message);

        // If the ONVIF module approach fails, fall back to the original method
        const listedProfile = this.profile_list[profileIndex];
        const listedEncoder = listedProfile && listedProfile['video'] && listedProfile['video']['encoder'];
        if (listedEncoder) {
          let encoderToken = listedEncoder['token'];
          let params = {
            ConfigurationToken: encoderToken,
          };

          console.log(`\n[ONVIF] Fallback: Getting video encoder configuration using token: ${encoderToken}`);

          this.services['media']
            .getVideoEncoderConfiguration(params, this.information)
            .then((result) => {
              resolve(result);
            })
            .catch((err) => {
              reject(err);
            });
        } else {
          reject(error);
        }
      });
  });

  if (this._isValidCallback(callback)) {
    promise
      .then((result) => {
        callback(null, result);
      })
      .catch((error) => {
        callback(error);
      });
  } else {
    return promise;
  }
};

/* ------------------------------------------------------------------
 * Method: getVideoEncoderConfigurationOptions(profileIndex, [callback])
 * ---------------------------------------------------------------- */
OnvifDevice.prototype.getVideoEncoderConfigurationOptions = function (profileIndex, callback) {
  // Handle case where profileIndex is omitted and callback is first parameter
  if (typeof profileIndex === 'function' && callback === undefined) {
    callback = profileIndex;
    profileIndex = 0; // Default to first profile
  }

  // Handle case where profileIndex is undefined
  if (profileIndex === undefined) {
    profileIndex = 0; // Default to first profile
  }

  let promise = new Promise((resolve, reject) => {
    // Check if profileIndex is valid
    if (typeof profileIndex !== 'number' || profileIndex < 0 || profileIndex >= this.profile_list.length) {
      reject(new Error(`Invalid profile index: ${profileIndex}. Must be between 0 and ${this.profile_list.length - 1}`));
      return;
    }

    if (!this.services['media']) {
      reject(new Error('The device does not support media service.'));
      return;
    }

    // Tokens come from profile_list built during init (official-module
    // fallback only when they are missing there).
    this._getProfileTokens(profileIndex, 'encoder')
      .then((tokens) => {
        if (!tokens.encoderToken) {
          throw new Error('Could not find video encoder configuration token');
        }

        console.log(`\n[ONVIF] Getting video encoder configuration options using token: ${tokens.encoderToken}`);

        let params = {
          ConfigurationToken: tokens.encoderToken,
          ProfileToken: tokens.profileToken,
        };

        return this.services['media'].getVideoEncoderConfigurationOptions(params, this.information);
      })
      .then((result) => {
        resolve(result);
      })
      .catch((error) => {
        console.error('\n[ONVIF] Error getting encoder options:', error.message);

        // Retry once with tokens from profile_list — kept from the old
        // fallback because some cameras fail transiently under load.
        const listedProfile = this.profile_list[profileIndex];
        const listedEncoder = listedProfile && listedProfile['video'] && listedProfile['video']['encoder'];
        if (listedEncoder) {
          let params = {
            ConfigurationToken: listedEncoder['token'],
            ProfileToken: listedProfile['token'],
          };

          console.log(`\n[ONVIF] Fallback: Getting video encoder configuration options using token: ${listedEncoder['token']}`);

          this.services['media']
            .getVideoEncoderConfigurationOptions(params, this.information)
            .then((result) => {
              resolve(result);
            })
            .catch((err) => {
              reject(err);
            });
        } else {
          reject(error);
        }
      });
  });

  if (this._isValidCallback(callback)) {
    promise
      .then((result) => {
        callback(null, result);
      })
      .catch((error) => {
        callback(error);
      });
  } else {
    return promise;
  }
};

/* ------------------------------------------------------------------
 * Method: setVideoEncoderConfiguration(params, profileIndex, [callback])
 * - params:
 *   - Resolution         | Object | optional | Width and Height of the video
 *     - Width            | Number | optional | Width of the video
 *     - Height           | Number | optional | Height of the video
 *   - Encoding           | String | optional | Video encoding (H264, JPEG, etc.)
 *   - FrameRate          | Number | optional | Frame rate
 *   - Bitrate            | Number | optional | Bitrate
 *   - EncodingInterval   | Number | optional | Encoding interval (keyframe interval)
 *   - Quality            | Number | optional | Quality (1-100)
 *   - GovLength          | Number | optional | Group of Video frames length
 *   - H264               | Object | optional | H264 specific configuration
 *     - GovLength        | Number | optional | Group of Video frames length
 *     - H264Profile      | String | optional | H264 profile (Baseline, Main, etc.)
 * ---------------------------------------------------------------- */
OnvifDevice.prototype.setVideoEncoderConfiguration = function (params, profileIndex, callback) {
  // Handle case where profileIndex is omitted and callback is second parameter
  if (typeof profileIndex === 'function' && callback === undefined) {
    callback = profileIndex;
    profileIndex = 0; // Default to first profile
  }

  // Handle case where profileIndex is undefined
  if (profileIndex === undefined) {
    profileIndex = 0; // Default to first profile
  }

  let promise = new Promise((resolve, reject) => {
    if (!params || typeof params !== 'object') {
      reject(new Error('The first argument must be an object.'));
      return;
    }

    console.log('\n[ONVIF] Setting video encoder configuration:', JSON.stringify(params, null, 2));

    // Check if profileIndex is valid
    if (typeof profileIndex !== 'number' || profileIndex < 0 || profileIndex >= this.profile_list.length) {
      reject(new Error(`Invalid profile index: ${profileIndex}. Must be between 0 and ${this.profile_list.length - 1}`));
      return;
    }

    if (!this.services['media']) {
      reject(new Error('The device does not support media service.'));
      return;
    }

    // Tokens come from profile_list built during init (official-module
    // fallback only when they are missing there).
    this._getProfileTokens(profileIndex, 'encoder')
      .then((tokens) => {
        if (!tokens.encoderToken) {
          throw new Error('Could not find video encoder configuration token');
        }

        console.log(`\n[ONVIF] Setting video encoder configuration using token: ${tokens.encoderToken}`);

        // Create a copy of the params and add the ConfigurationToken
        let encoderParams = Object.assign({}, params);
        encoderParams.ConfigurationToken = tokens.encoderToken;

        // Use our service to set the configuration
        return this.services['media'].setVideoEncoderConfiguration(encoderParams);
      })
      .then((result) => {
        console.log('\n[ONVIF] Video encoder configuration updated successfully');
        resolve(result);
      })
      .catch((error) => {
        console.error('\n[ONVIF] Error updating video encoder configuration:', error.message);
        reject(error);
      });
  });

  if (this._isValidCallback(callback)) {
    promise
      .then((result) => {
        callback(null, result);
      })
      .catch((error) => {
        callback(error);
      });
  } else {
    return promise;
  }
};

/* ------------------------------------------------------------------
 * Method: getCameraCapabilities(profileIndex, [callback])
 * Returns a structured object with all camera capabilities including
 * imaging options and video encoder configuration options
 * ---------------------------------------------------------------- */
OnvifDevice.prototype.getCameraCapabilities = function (callback) {
  let promise = new Promise(async (resolve, reject) => {
    // Store original profile to restore later
    const originalProfile = this.current_profile;

    console.log(`\n[ONVIF] Getting camera capabilities for all profiles...`);

    try {
      // Fetch imaging options and settings only once as they're the same for all profiles
      let commonImagingOptions = null;
      let commonImagingSettings = null;

      // Get imaging options and settings only if imaging service is available
      if (this.services['imaging']) {
        try {
          console.log(`\n[ONVIF] Getting common imaging options for all profiles...`);

          // Imaging is per video source: use the current profile's index so a
          // device restricted to a lens (restrictToVideoSource) reads imaging
          // of its own video source. Unrestricted devices keep profile 0.
          const baseIndex = Math.max(this.profile_list.indexOf(originalProfile), 0);

          // Get imaging options
          const imagingResult = await this.getImagingOptions(baseIndex);
          if (imagingResult && imagingResult.data && imagingResult.data.GetOptionsResponse && imagingResult.data.GetOptionsResponse.ImagingOptions) {
            commonImagingOptions = this._parseImagingOptions(imagingResult.data.GetOptionsResponse.ImagingOptions);
          }

          // Get imaging settings
          const imagingSettings = await this.getImagingSettings(baseIndex);
          if (imagingSettings && imagingSettings.data && imagingSettings.data.GetImagingSettingsResponse) {
            commonImagingSettings = imagingSettings.data.GetImagingSettingsResponse.ImagingSettings;
          }

          console.log(`\n[ONVIF] Common imaging options and settings retrieved successfully`);
        } catch (error) {
          console.error(`\n[ONVIF] Error getting common imaging options and settings: ${error.message}`);
        }
      }

      // Process profiles with limited concurrency — too many parallel
      // requests make some cameras drop sockets.
      const results = await mapWithConcurrency(this.profile_list, CAPABILITIES_CONCURRENCY, async (profile, profileIndex) => {
        console.log(`\n[ONVIF] Processing profile ${profileIndex}...`);

        // Prepare result object for this profile
        const capabilities = {
          profile: profileIndex,
          imaging: commonImagingOptions, // Use the common imaging options
          currentImagingSettings: commonImagingSettings, // Use the common imaging settings
          videoEncoder: null,
        };

        try {
          // Get video encoder configuration
          const encoderConfig = await this.getVideoEncoderConfiguration(profileIndex).catch(() => null);

          // Only continue if we have a valid encoder configuration
          if (
            encoderConfig &&
            encoderConfig.data &&
            encoderConfig.data.GetVideoEncoderConfigurationResponse &&
            encoderConfig.data.GetVideoEncoderConfigurationResponse.Configuration
          ) {
            const config = encoderConfig.data.GetVideoEncoderConfigurationResponse.Configuration;

            // Check for H264 or H265 encoding
            const encodingValue = config.Encoding || config.encoding || (config.$ && (config.$.Encoding || config.$.encoding)) || 'unknown';

            // Skip profiles that don't use H264 or H265
            if (encodingValue !== 'H264' && encodingValue !== 'H265') {
              console.log(`\n[ONVIF] Skipping profile ${profileIndex} with encoding ${encodingValue} - only including H264/H265 profiles`);
              return null;
            }

            console.log(`\n[ONVIF] Including profile ${profileIndex} with encoding ${encodingValue}`);
            capabilities.currentVideoEncoderConfiguration = config;

            // Get video encoder options if service is available
            if (this.services['media']) {
              try {
                const encoderOptionsResult = await this.getVideoEncoderConfigurationOptions(profileIndex);
                if (encoderOptionsResult && encoderOptionsResult.data && encoderOptionsResult.data.GetVideoEncoderConfigurationOptionsResponse) {
                  const options = encoderOptionsResult.data.GetVideoEncoderConfigurationOptionsResponse.Options;
                  console.log(`\n[ONVIF] Got video encoder options for profile ${profileIndex}`);

                  // Parse options
                  capabilities.videoEncoder = this._parseVideoEncoderOptions(options);
                }
              } catch (error) {
                console.error(`\n[ONVIF] Error getting video encoder configuration options for profile ${profileIndex}: ${error.message}`);
              }
            }
          } else {
            console.log(`\n[ONVIF] Profile ${profileIndex} has no encoder configuration, trying to include it using fallback...`);

            // Fallback: Try to use our profile_list information
            if (
              this.profile_list[profileIndex] &&
              this.profile_list[profileIndex].video &&
              this.profile_list[profileIndex].video.encoder &&
              this.profile_list[profileIndex].video.encoder.encoding
            ) {
              const encodingFromProfileList = this.profile_list[profileIndex].video.encoder.encoding;

              // Skip profiles that don't use H264 or H265
              if (encodingFromProfileList !== 'H264' && encodingFromProfileList !== 'H265') {
                console.log(`\n[ONVIF] Skipping profile ${profileIndex} with encoding ${encodingFromProfileList} from profile_list - only including H264/H265 profiles`);
                return null;
              }

              console.log(`\n[ONVIF] Using fallback for profile ${profileIndex} with encoding ${encodingFromProfileList}`);

              // Get video encoder options if service is available
              if (this.services['media']) {
                try {
                  const encoderOptionsResult = await this.getVideoEncoderConfigurationOptions(profileIndex);
                  if (encoderOptionsResult && encoderOptionsResult.data && encoderOptionsResult.data.GetVideoEncoderConfigurationOptionsResponse) {
                    const options = encoderOptionsResult.data.GetVideoEncoderConfigurationOptionsResponse.Options;
                    console.log(`\n[ONVIF] Got video encoder options for profile ${profileIndex}`);

                    // Parse options
                    capabilities.videoEncoder = this._parseVideoEncoderOptions(options);

                    // Use profile_list info for current config
                    const listedResolution = this.profile_list[profileIndex].video.encoder.resolution;
                    capabilities.currentVideoEncoderConfiguration = {
                      Encoding: encodingFromProfileList,
                      Resolution: {
                        Width: (listedResolution && listedResolution.width) || 0,
                        Height: (listedResolution && listedResolution.height) || 0,
                      },
                      Quality: this.profile_list[profileIndex].video.encoder.quality || 0,
                      RateControl: {
                        FrameRateLimit: this.profile_list[profileIndex].video.encoder.framerate || 0,
                        BitrateLimit: this.profile_list[profileIndex].video.encoder.bitrate || 0,
                      },
                    };
                  }
                } catch (error) {
                  console.error(`\n[ONVIF] Error in fallback for profile ${profileIndex}: ${error.message}`);
                }
              }
            } else {
              console.log(`\n[ONVIF] Skipping profile ${profileIndex} - no valid encoder configuration found and no fallback data available`);
              return null; // Return null for this profile to be filtered out later
            }
          }

          return capabilities;
        } catch (error) {
          console.error(`\n[ONVIF] Error processing profile ${profileIndex}: ${error.message}`);
          return null; // Return null for this profile to be filtered out later
        }
      });

      // Filter out null results (skipped or failed profiles)
      const allCapabilities = results.filter((result) => result !== null);

      if (allCapabilities.length === 0) {
        reject(new Error('No H264 or H265 profiles found'));
      } else {
        console.log(`\n[ONVIF] Camera capabilities retrieved successfully for ${allCapabilities.length} H264/H265 profiles`);
        resolve(allCapabilities);
      }
    } catch (error) {
      reject(error);
    }
  });

  if (this._isValidCallback(callback)) {
    promise
      .then((result) => {
        callback(null, result);
      })
      .catch((error) => {
        callback(error);
      });
  } else {
    return promise;
  }
};

/* ------------------------------------------------------------------
 * Method: _parseImagingOptions(imagingOptions)
 * Parse imaging options and extract limits
 * ---------------------------------------------------------------- */
OnvifDevice.prototype._parseImagingOptions = function (imagingOptions) {
  const result = {};

  // Parse brightness
  if (imagingOptions.Brightness) {
    result.brightness = {
      min: parseFloat(imagingOptions.Brightness.Min) || 0,
      max: parseFloat(imagingOptions.Brightness.Max) || 100,
    };
  }

  // Parse contrast
  if (imagingOptions.Contrast) {
    result.contrast = {
      min: parseFloat(imagingOptions.Contrast.Min) || 0,
      max: parseFloat(imagingOptions.Contrast.Max) || 100,
    };
  }

  // Parse color saturation
  if (imagingOptions.ColorSaturation) {
    result.colorSaturation = {
      min: parseFloat(imagingOptions.ColorSaturation.Min) || 0,
      max: parseFloat(imagingOptions.ColorSaturation.Max) || 100,
    };
  }

  // Parse sharpness
  if (imagingOptions.Sharpness) {
    result.sharpness = {
      min: parseFloat(imagingOptions.Sharpness.Min) || 0,
      max: parseFloat(imagingOptions.Sharpness.Max) || 100,
    };
  }

  // Parse BacklightCompensation
  if (imagingOptions.BacklightCompensation) {
    result.backlightCompensation = {
      modes: imagingOptions.BacklightCompensation.Mode || ['ON', 'OFF'],
    };

    if (imagingOptions.BacklightCompensation.Level) {
      result.backlightCompensation.level = {
        min: parseFloat(imagingOptions.BacklightCompensation.Level.Min) || 0,
        max: parseFloat(imagingOptions.BacklightCompensation.Level.Max) || 100,
      };
    }
  }

  // Parse WhiteBalance
  if (imagingOptions.WhiteBalance) {
    result.whiteBalance = {
      modes: imagingOptions.WhiteBalance.Mode || ['AUTO', 'MANUAL'],
    };

    if (imagingOptions.WhiteBalance.YrGain) {
      result.whiteBalance.yrGain = {
        min: parseFloat(imagingOptions.WhiteBalance.YrGain.Min) || 0,
        max: parseFloat(imagingOptions.WhiteBalance.YrGain.Max) || 100,
      };
    }

    if (imagingOptions.WhiteBalance.YbGain) {
      result.whiteBalance.ybGain = {
        min: parseFloat(imagingOptions.WhiteBalance.YbGain.Min) || 0,
        max: parseFloat(imagingOptions.WhiteBalance.YbGain.Max) || 100,
      };
    }
  }

  // Parse WideDynamicRange
  if (imagingOptions.WideDynamicRange) {
    result.wideDynamicRange = {
      modes: imagingOptions.WideDynamicRange.Mode || ['ON', 'OFF'],
    };

    if (imagingOptions.WideDynamicRange.Level) {
      result.wideDynamicRange.level = {
        min: parseFloat(imagingOptions.WideDynamicRange.Level.Min) || 0,
        max: parseFloat(imagingOptions.WideDynamicRange.Level.Max) || 100,
      };
    }
  }

  // Parse Focus
  if (imagingOptions.Focus) {
    result.focus = {
      modes: imagingOptions.Focus.Mode || ['AUTO', 'MANUAL'],
    };

    if (imagingOptions.Focus.DefaultSpeed) {
      result.focus.defaultSpeed = {
        min: parseFloat(imagingOptions.Focus.DefaultSpeed.Min) || 0,
        max: parseFloat(imagingOptions.Focus.DefaultSpeed.Max) || 100,
      };
    }

    if (imagingOptions.Focus.NearLimit) {
      result.focus.nearLimit = {
        min: parseFloat(imagingOptions.Focus.NearLimit.Min) || 0,
        max: parseFloat(imagingOptions.Focus.NearLimit.Max) || 100,
      };
    }

    if (imagingOptions.Focus.FarLimit) {
      result.focus.farLimit = {
        min: parseFloat(imagingOptions.Focus.FarLimit.Min) || 0,
        max: parseFloat(imagingOptions.Focus.FarLimit.Max) || 100,
      };
    }
  }

  // Parse Exposure
  if (imagingOptions.Exposure) {
    result.exposure = {
      modes: imagingOptions.Exposure.Mode || ['AUTO', 'MANUAL'],
    };

    if (imagingOptions.Exposure.MinExposureTime) {
      result.exposure.minExposureTime = {
        min: parseFloat(imagingOptions.Exposure.MinExposureTime.Min) || 0,
        max: parseFloat(imagingOptions.Exposure.MinExposureTime.Max) || 100,
      };
    }

    if (imagingOptions.Exposure.MaxExposureTime) {
      result.exposure.maxExposureTime = {
        min: parseFloat(imagingOptions.Exposure.MaxExposureTime.Min) || 0,
        max: parseFloat(imagingOptions.Exposure.MaxExposureTime.Max) || 100,
      };
    }

    if (imagingOptions.Exposure.MinGain) {
      result.exposure.minGain = {
        min: parseFloat(imagingOptions.Exposure.MinGain.Min) || 0,
        max: parseFloat(imagingOptions.Exposure.MinGain.Max) || 100,
      };
    }

    if (imagingOptions.Exposure.MaxGain) {
      result.exposure.maxGain = {
        min: parseFloat(imagingOptions.Exposure.MaxGain.Min) || 0,
        max: parseFloat(imagingOptions.Exposure.MaxGain.Max) || 100,
      };
    }
  }

  return result;
};

/* ------------------------------------------------------------------
 * Method: _parseVideoEncoderOptions(videoEncoderOptions)
 * Parse video encoder options and extract limits
 * ---------------------------------------------------------------- */
OnvifDevice.prototype._parseVideoEncoderOptions = function (videoEncoderOptions) {
  // Check if valid input
  if (!videoEncoderOptions || typeof videoEncoderOptions !== 'object') {
    console.log('\n[ONVIF] Invalid video encoder options format:', videoEncoderOptions);
    return null;
  }

  console.log('\n[ONVIF] Parsing videoEncoderOptions:', Object.keys(videoEncoderOptions).join(', '));

  // Initialize result object
  const result = {
    quality: null,
    resolutions: [],
    encoding: [],
    frameRate: null,
    encodingInterval: null,
    govLength: null,
    bitrate: null,
  };

  // Handle array format (typically from first format where each element is a different encoding type)
  if (Array.isArray(videoEncoderOptions)) {
    console.log(`\n[ONVIF] Processing array format with ${videoEncoderOptions.length} elements`);

    videoEncoderOptions.forEach((encoderOption) => {
      // Get encoding type
      if (encoderOption.Encoding) {
        if (!result.encoding.includes(encoderOption.Encoding)) {
          result.encoding.push(encoderOption.Encoding);
        }
      }

      // Process quality range
      if (encoderOption.QualityRange && !result.quality) {
        result.quality = {
          min: parseFloat(encoderOption.QualityRange.Min) || 0,
          max: parseFloat(encoderOption.QualityRange.Max) || 100,
        };
      }

      // Process resolutions
      if (encoderOption.ResolutionsAvailable) {
        const resolutions = Array.isArray(encoderOption.ResolutionsAvailable) ? encoderOption.ResolutionsAvailable : [encoderOption.ResolutionsAvailable];

        resolutions.forEach((res) => {
          const resolution = {
            width: parseInt(res.Width || res.width, 10),
            height: parseInt(res.Height || res.height, 10),
          };

          // Check if this resolution is already in the list
          const exists = result.resolutions.some((r) => r.width === resolution.width && r.height === resolution.height);

          if (!exists) {
            result.resolutions.push(resolution);
          }
        });
      }

      // Process bitrate range
      if (encoderOption.BitrateRange && !result.bitrate) {
        result.bitrate = {
          min: parseInt(encoderOption.BitrateRange.Min, 10) || 0,
          max: parseInt(encoderOption.BitrateRange.Max, 10) || 10000,
        };
      }

      // Process frame rate range (might be in $ attribute or derived from FrameRatesSupported)
      if (encoderOption.$ && encoderOption.$.FrameRatesSupported && !result.frameRate) {
        const rates = encoderOption.$.FrameRatesSupported.split(' ').map((rate) => parseFloat(rate));
        result.frameRate = {
          min: Math.min(...rates),
          max: Math.max(...rates),
        };
      }

      // Process GOV length range
      if (encoderOption.$ && encoderOption.$.GovLengthRange && !result.govLength) {
        const [min, max] = encoderOption.$.GovLengthRange.split(' ').map(Number);
        result.govLength = {
          min: min || 1,
          max: max || 100,
        };
      }

      // Process RateControl if available
      if (encoderOption.RateControl && !result.bitrate) {
        const bitrateLimit = parseInt(encoderOption.RateControl.BitrateLimit, 10);
        if (!isNaN(bitrateLimit)) {
          // Create a bitrate range based on the current limit
          result.bitrate = {
            min: Math.max(1, Math.floor(bitrateLimit * 0.1)), // Set min to 10% of current or 1, whichever is higher
            max: Math.ceil(bitrateLimit * 3), // Set max to 3x current as a reasonable limit
            current: bitrateLimit,
          };
        }
      }

      // Check for Extension containing encoding-specific settings
      if (encoderOption.Extension) {
        // Process H264 extension
        if (encoderOption.Extension.H264 && encoderOption.Extension.H264.BitrateRange && !result.bitrate) {
          result.bitrate = {
            min: parseInt(encoderOption.Extension.H264.BitrateRange.Min, 10) || 0,
            max: parseInt(encoderOption.Extension.H264.BitrateRange.Max, 10) || 10000,
          };
        }

        // Process H265 extension
        if (encoderOption.Extension.H265 && encoderOption.Extension.H265.BitrateRange && !result.bitrate) {
          result.bitrate = {
            min: parseInt(encoderOption.Extension.H265.BitrateRange.Min, 10) || 0,
            max: parseInt(encoderOption.Extension.H265.BitrateRange.Max, 10) || 10000,
          };
        }
      }
    });
  }

  // Process object format (handle both second and third formats)
  else {
    // Extract quality range directly from root
    if (videoEncoderOptions.QualityRange) {
      result.quality = {
        min: parseFloat(videoEncoderOptions.QualityRange.Min) || 0,
        max: parseFloat(videoEncoderOptions.QualityRange.Max) || 100,
      };
    }

    // Extract resolutions directly from root
    if (videoEncoderOptions.ResolutionsAvailable) {
      const resolutions = Array.isArray(videoEncoderOptions.ResolutionsAvailable) ? videoEncoderOptions.ResolutionsAvailable : [videoEncoderOptions.ResolutionsAvailable];

      resolutions.forEach((res) => {
        result.resolutions.push({
          width: parseInt(res.Width || res.width, 10),
          height: parseInt(res.Height || res.height, 10),
        });
      });
    }

    // Extract encoding directly from root
    if (videoEncoderOptions.Encoding && !result.encoding.includes(videoEncoderOptions.Encoding)) {
      result.encoding.push(videoEncoderOptions.Encoding);
    }

    // Extract bitrate range directly from root
    if (videoEncoderOptions.BitrateRange) {
      result.bitrate = {
        min: parseInt(videoEncoderOptions.BitrateRange.Min, 10) || 0,
        max: parseInt(videoEncoderOptions.BitrateRange.Max, 10) || 10000,
      };
    }

    // Extract bitrate from RateControl if available
    if (videoEncoderOptions.RateControl && videoEncoderOptions.RateControl.bitrateLimit && !result.bitrate) {
      const bitrateLimit = parseInt(videoEncoderOptions.RateControl.bitrateLimit, 10);
      if (!isNaN(bitrateLimit)) {
        result.bitrate = {
          min: Math.max(1, Math.floor(bitrateLimit * 0.1)), // Set min to 10% of current or 1, whichever is higher
          max: Math.ceil(bitrateLimit * 3), // Set max to 3x current as a reasonable limit
          current: bitrateLimit,
        };
      }
    }

    // Extract frame rate range directly from root
    if (videoEncoderOptions.FrameRateRange) {
      result.frameRate = {
        min: parseFloat(videoEncoderOptions.FrameRateRange.Min) || 0,
        max: parseFloat(videoEncoderOptions.FrameRateRange.Max) || 30,
      };
    }

    // Extract framerate from RateControl if available
    if (videoEncoderOptions.RateControl && videoEncoderOptions.RateControl.frameRateLimit && !result.frameRate) {
      const frameRateLimit = parseFloat(videoEncoderOptions.RateControl.frameRateLimit);
      if (!isNaN(frameRateLimit)) {
        result.frameRate = {
          min: 1,
          max: Math.max(30, frameRateLimit * 2), // Set max to 2x current or 30, whichever is higher
          current: frameRateLimit,
        };
      }
    }

    // Extract encoding interval range directly from root
    if (videoEncoderOptions.EncodingIntervalRange) {
      result.encodingInterval = {
        min: parseInt(videoEncoderOptions.EncodingIntervalRange.Min, 10) || 1,
        max: parseInt(videoEncoderOptions.EncodingIntervalRange.Max, 10) || 100,
      };
    }

    // Extract encoding interval from RateControl if available
    if (videoEncoderOptions.RateControl && videoEncoderOptions.RateControl.encodingInterval && !result.encodingInterval) {
      const encodingInterval = parseInt(videoEncoderOptions.RateControl.encodingInterval, 10);
      if (!isNaN(encodingInterval)) {
        result.encodingInterval = {
          min: 1,
          max: Math.max(100, encodingInterval * 2),
          current: encodingInterval,
        };
      }
    }

    // Extract GOV length range directly from root
    if (videoEncoderOptions.GovLengthRange) {
      result.govLength = {
        min: parseInt(videoEncoderOptions.GovLengthRange.Min, 10) || 1,
        max: parseInt(videoEncoderOptions.GovLengthRange.Max, 10) || 100,
      };
    }

    // Extract GOV length from H264/H265 settings if available
    if (videoEncoderOptions.H264 && videoEncoderOptions.H264.GovLength && !result.govLength) {
      const govLength = parseInt(videoEncoderOptions.H264.GovLength, 10);
      if (!isNaN(govLength)) {
        result.govLength = {
          min: 1,
          max: Math.max(100, govLength * 2),
          current: govLength,
        };
      }
    } else if (videoEncoderOptions.H265 && videoEncoderOptions.H265.GovLength && !result.govLength) {
      const govLength = parseInt(videoEncoderOptions.H265.GovLength, 10);
      if (!isNaN(govLength)) {
        result.govLength = {
          min: 1,
          max: Math.max(100, govLength * 2),
          current: govLength,
        };
      }
    }

    // Process encoding-specific sections (H264, H265, JPEG)
    const encodingTypes = ['H264', 'H265', 'JPEG'];

    encodingTypes.forEach((encodingType) => {
      if (videoEncoderOptions[encodingType]) {
        // Add encoding type
        if (!result.encoding.includes(encodingType)) {
          result.encoding.push(encodingType);
        }

        // Create encoding-specific section if we need it
        const typeKey = encodingType.toLowerCase();
        if (!result[typeKey]) {
          result[typeKey] = {};
        }

        // Extract resolutions
        if (videoEncoderOptions[encodingType].ResolutionsAvailable) {
          const resolutions = Array.isArray(videoEncoderOptions[encodingType].ResolutionsAvailable)
            ? videoEncoderOptions[encodingType].ResolutionsAvailable
            : [videoEncoderOptions[encodingType].ResolutionsAvailable];

          result[typeKey].resolutions = resolutions.map((res) => ({
            width: parseInt(res.Width || res.width, 10),
            height: parseInt(res.Height || res.height, 10),
          }));

          // Add to global resolutions if not already there
          resolutions.forEach((res) => {
            const resolution = {
              width: parseInt(res.Width || res.width, 10),
              height: parseInt(res.Height || res.height, 10),
            };

            const exists = result.resolutions.some((r) => r.width === resolution.width && r.height === resolution.height);

            if (!exists) {
              result.resolutions.push(resolution);
            }
          });
        }

        // Extract frame rate range
        if (videoEncoderOptions[encodingType].FrameRateRange) {
          result[typeKey].frameRate = {
            min: parseFloat(videoEncoderOptions[encodingType].FrameRateRange.Min) || 0,
            max: parseFloat(videoEncoderOptions[encodingType].FrameRateRange.Max) || 30,
          };

          // Update global frameRate if not set or if this one has a wider range
          if (!result.frameRate) {
            result.frameRate = { ...result[typeKey].frameRate };
          } else {
            result.frameRate.min = Math.min(result.frameRate.min, result[typeKey].frameRate.min);
            result.frameRate.max = Math.max(result.frameRate.max, result[typeKey].frameRate.max);
          }
        }

        // Extract encoding interval range
        if (videoEncoderOptions[encodingType].EncodingIntervalRange) {
          result[typeKey].encodingInterval = {
            min: parseInt(videoEncoderOptions[encodingType].EncodingIntervalRange.Min, 10) || 1,
            max: parseInt(videoEncoderOptions[encodingType].EncodingIntervalRange.Max, 10) || 100,
          };

          // Update global encodingInterval if not set or if this one has a wider range
          if (!result.encodingInterval) {
            result.encodingInterval = { ...result[typeKey].encodingInterval };
          } else {
            result.encodingInterval.min = Math.min(result.encodingInterval.min, result[typeKey].encodingInterval.min);
            result.encodingInterval.max = Math.max(result.encodingInterval.max, result[typeKey].encodingInterval.max);
          }
        }

        // Extract bitrate range
        if (videoEncoderOptions[encodingType].BitrateRange) {
          result[typeKey].bitrate = {
            min: parseInt(videoEncoderOptions[encodingType].BitrateRange.Min, 10) || 0,
            max: parseInt(videoEncoderOptions[encodingType].BitrateRange.Max, 10) || 10000,
          };

          // Update global bitrate if not set or if this one has a wider range
          if (!result.bitrate) {
            result.bitrate = { ...result[typeKey].bitrate };
          } else {
            result.bitrate.min = Math.min(result.bitrate.min, result[typeKey].bitrate.min);
            result.bitrate.max = Math.max(result.bitrate.max, result[typeKey].bitrate.max);
          }
        }

        // Extract GOV length range
        if (videoEncoderOptions[encodingType].GovLengthRange) {
          result[typeKey].govLength = {
            min: parseInt(videoEncoderOptions[encodingType].GovLengthRange.Min, 10) || 1,
            max: parseInt(videoEncoderOptions[encodingType].GovLengthRange.Max, 10) || 100,
          };

          // Update global govLength if not set or if this one has a wider range
          if (!result.govLength) {
            result.govLength = { ...result[typeKey].govLength };
          } else {
            result.govLength.min = Math.min(result.govLength.min, result[typeKey].govLength.min);
            result.govLength.max = Math.max(result.govLength.max, result[typeKey].govLength.max);
          }
        }

        // Extract profiles supported
        const profilesKey = `${encodingType}ProfilesSupported`;
        if (videoEncoderOptions[encodingType][profilesKey]) {
          const profiles = videoEncoderOptions[encodingType][profilesKey];
          result[typeKey].profiles = Array.isArray(profiles) ? profiles : [profiles];
        }
      }
    });

    // Check Extension section for BitrateRange if not found yet
    if (!result.bitrate && videoEncoderOptions.Extension) {
      console.log('\n[ONVIF] Checking Extension section for BitrateRange');

      // Check for H264 in Extension
      if (videoEncoderOptions.Extension.H264 && videoEncoderOptions.Extension.H264.BitrateRange) {
        console.log('\n[ONVIF] Found BitrateRange in Extension.H264');
        result.bitrate = {
          min: parseInt(videoEncoderOptions.Extension.H264.BitrateRange.Min, 10) || 0,
          max: parseInt(videoEncoderOptions.Extension.H264.BitrateRange.Max, 10) || 10000,
        };

        // Also add to h264-specific section if it exists
        if (result.h264) {
          result.h264.bitrate = { ...result.bitrate };
        }
      }

      // Check for H265 in Extension
      if (!result.bitrate && videoEncoderOptions.Extension.H265 && videoEncoderOptions.Extension.H265.BitrateRange) {
        console.log('\n[ONVIF] Found BitrateRange in Extension.H265');
        result.bitrate = {
          min: parseInt(videoEncoderOptions.Extension.H265.BitrateRange.Min, 10) || 0,
          max: parseInt(videoEncoderOptions.Extension.H265.BitrateRange.Max, 10) || 10000,
        };

        // Also add to h265-specific section if it exists
        if (result.h265) {
          result.h265.bitrate = { ...result.bitrate };
        }
      }
    }
  }

  // If we still don't have bitrate information, try to extract it from the current configuration
  if (!result.bitrate && videoEncoderOptions.rateControl && videoEncoderOptions.rateControl.bitrateLimit) {
    const bitrateLimit = parseInt(videoEncoderOptions.rateControl.bitrateLimit, 10);
    if (!isNaN(bitrateLimit)) {
      result.bitrate = {
        min: Math.max(1, Math.floor(bitrateLimit * 0.1)), // Set min to 10% of current or 1, whichever is higher
        max: Math.ceil(bitrateLimit * 3), // Set max to 3x current as a reasonable limit
        current: bitrateLimit,
      };
    }
  }

  return result;
};
