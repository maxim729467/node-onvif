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

  const streams = this.profile_list.map((profile, index) => {
    const streamData = {};
    let urlIpAddress = null;
    const encoder = profile['video']['encoder'] || {};
    streamData.url = profile['stream']['rtsp'] || '';

    const ipAddressOrHost = new URL(this.xaddr).hostname;
    const urlIpAddressArr = streamData.url.match(/\/\/([^:/]+)/);
    if (urlIpAddressArr && urlIpAddressArr.length) {
      urlIpAddress = urlIpAddressArr[1];
    }

    if (urlIpAddress) {
      streamData.url = streamData.url.replace(urlIpAddress, ipAddressOrHost);
    }

    streamData.isMainStream = index === 0;
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
      ProfileToken: this.current_profile['token'],
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
      ProfileToken: this.current_profile['token'],
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
        reject(error);
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
      });
      resolve();
    });
  });
  return promise;
};

// Media::GetStreamURI (Access Class: READ_MEDIA)
OnvifDevice.prototype._mediaGetStreamURI = function () {
  let protocol_list = ['UDP', 'HTTP', 'RTSP'];
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

    // Store original profile to restore later
    const originalProfile = this.current_profile;

    // Change to requested profile
    this.changeProfile(profileIndex);

    if (!this.services['imaging']) {
      // Restore original profile
      this.current_profile = originalProfile;
      reject(new Error('The device does not support imaging.'));
      return;
    }

    // Get profiles from camera using official ONVIF module
    this.getProfilesFromDevice()
      .then((profiles) => {
        // Get profile at same index as current profile index
        const profile = profiles[profileIndex] || profiles[0];

        if (!profile || !profile.videoSourceConfiguration) {
          throw new Error(`No video source configuration found for profile ${profileIndex}`);
        }

        // Get the source token
        const sourceToken = profile.videoSourceConfiguration.sourceToken;

        if (sourceToken === null || sourceToken === undefined) {
          throw new Error('Could not find video source token');
        }

        // Ensure sourceToken is a string
        let params = {
          VideoSourceToken: sourceToken !== null && sourceToken !== undefined ? sourceToken.toString() : '',
        };

        return this.services['imaging'].getImagingSettings(params);
      })
      .then((result) => {
        // Restore original profile
        this.current_profile = originalProfile;
        resolve(result);
      })
      .catch((error) => {
        // Restore original profile and reject with error
        this.current_profile = originalProfile;
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

    // Store original profile to restore later
    const originalProfile = this.current_profile;

    // Change to requested profile
    this.changeProfile(profileIndex);

    if (!this.services['imaging']) {
      // Restore original profile
      this.current_profile = originalProfile;
      reject(new Error('The device does not support imaging.'));
      return;
    }

    // First get the current imaging settings
    this.getImagingSettings(profileIndex)
      .then((currentSettings) => {
        console.log('\n[ONVIF] Current imaging settings:', JSON.stringify(currentSettings.data.GetImagingSettingsResponse.ImagingSettings, null, 2));

        // Get profiles from camera using official ONVIF module
        return this.getProfilesFromDevice();
      })
      .then((profiles) => {
        // Get profile at same index as profile index
        const profile = profiles[profileIndex] || profiles[0];

        if (!profile || !profile.videoSourceConfiguration) {
          throw new Error(`No video source configuration found for profile ${profileIndex}`);
        }

        // Get the source token
        const sourceToken = profile.videoSourceConfiguration.sourceToken;

        if (sourceToken === null || sourceToken === undefined) {
          throw new Error('Could not find video source token');
        }

        let p = JSON.parse(JSON.stringify(params));
        // Ensure sourceToken is a string
        p['VideoSourceToken'] = sourceToken !== null && sourceToken !== undefined ? sourceToken.toString() : '';

        console.log('\n[ONVIF] Sending imaging settings to camera with source token:', sourceToken);
        return this.services['imaging'].setImagingSettings(p);
      })
      .then((result) => {
        console.log('\n[ONVIF] Imaging settings updated successfully');
        // Restore original profile
        this.current_profile = originalProfile;
        resolve(result);
      })
      .catch((error) => {
        console.error('\n[ONVIF] Error updating imaging settings:', error.message);
        // Restore original profile and reject with error
        this.current_profile = originalProfile;
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

    // Store original profile to restore later
    const originalProfile = this.current_profile;

    // Change to requested profile
    this.changeProfile(profileIndex);

    if (!this.services['imaging']) {
      // Restore original profile
      this.current_profile = originalProfile;
      reject(new Error('The device does not support imaging.'));
      return;
    }

    // Get profiles from camera using official ONVIF module
    this.getProfilesFromDevice()
      .then((profiles) => {
        // Get profile at requested profile index
        const profile = profiles[profileIndex] || profiles[0];

        if (!profile || !profile.videoSourceConfiguration) {
          throw new Error(`No video source configuration found for profile ${profileIndex}`);
        }

        // Get the source token
        const sourceToken = profile.videoSourceConfiguration.sourceToken;

        if (sourceToken === null || sourceToken === undefined) {
          throw new Error('Could not find video source token');
        }

        // Ensure sourceToken is a string
        let params = {
          VideoSourceToken: sourceToken !== null && sourceToken !== undefined ? sourceToken.toString() : '',
        };

        return this.services['imaging'].getOptions(params);
      })
      .then((result) => {
        // Restore original profile
        this.current_profile = originalProfile;
        resolve(result);
      })
      .catch((error) => {
        // Restore original profile and reject with error
        this.current_profile = originalProfile;
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
  // Require the official ONVIF npm module
  const onvif = require('onvif');

  return new Promise((resolve, reject) => {
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

    // Store original profile to restore later
    const originalProfile = this.current_profile;

    // Change to requested profile
    this.changeProfile(profileIndex);

    if (!this.services['media']) {
      // Restore original profile
      this.current_profile = originalProfile;
      reject(new Error('The device does not support media service.'));
      return;
    }

    // Get profiles from camera using official ONVIF module
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

        // Restore original profile and resolve
        this.current_profile = originalProfile;
        resolve(result);
      })
      .catch((error) => {
        console.error('\n[ONVIF] Error getting encoder configuration:', error.message);

        // If the ONVIF module approach fails, fall back to the original method
        if (this.current_profile['video']['encoder']) {
          let encoderToken = this.current_profile['video']['encoder']['token'];
          let params = {
            ConfigurationToken: encoderToken,
          };

          console.log(`\n[ONVIF] Fallback: Getting video encoder configuration using token: ${encoderToken}`);

          this.services['media']
            .getVideoEncoderConfiguration(params, this.information)
            .then((result) => {
              // Restore original profile
              this.current_profile = originalProfile;
              resolve(result);
            })
            .catch((err) => {
              // Restore original profile
              this.current_profile = originalProfile;
              reject(err);
            });
        } else {
          // Restore original profile and reject
          this.current_profile = originalProfile;
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

    // Store original profile to restore later
    const originalProfile = this.current_profile;

    // Change to requested profile
    this.changeProfile(profileIndex);

    if (!this.services['media']) {
      // Restore original profile
      this.current_profile = originalProfile;
      reject(new Error('The device does not support media service.'));
      return;
    }

    // The official ONVIF module doesn't have a direct method for getting encoder options
    // We need to use our own service method but with the correct profile and token

    // Get profiles from camera using official ONVIF module to get the token
    this.getProfilesFromDevice()
      .then((profiles) => {
        // Get profile at requested profile index
        const profile = profiles[profileIndex] || profiles[0];

        if (!profile || !profile.videoEncoderConfiguration) {
          throw new Error(`No video encoder configuration found for profile ${profileIndex}`);
        }

        // Get the token from the video encoder configuration
        const configToken = profile.videoEncoderConfiguration.$.token;

        if (!configToken) {
          throw new Error('Could not find video encoder configuration token');
        }

        console.log(`\n[ONVIF] Getting video encoder configuration options using token: ${configToken}`);

        // Use our service to get the options
        let params = {
          ConfigurationToken: configToken,
          ProfileToken: profile.$.token,
        };

        return this.services['media'].getVideoEncoderConfigurationOptions(params, this.information);
      })
      .then((result) => {
        // Restore original profile
        this.current_profile = originalProfile;
        resolve(result);
      })
      .catch((error) => {
        console.error('\n[ONVIF] Error getting encoder options:', error.message);

        // Fallback to original method
        if (this.current_profile['video']['encoder']) {
          let encoderToken = this.current_profile['video']['encoder']['token'];
          let params = {
            ConfigurationToken: encoderToken,
            ProfileToken: this.current_profile['token'],
          };

          console.log(`\n[ONVIF] Fallback: Getting video encoder configuration options using token: ${encoderToken}`);

          this.services['media']
            .getVideoEncoderConfigurationOptions(params, this.information)
            .then((result) => {
              // Restore original profile
              this.current_profile = originalProfile;
              resolve(result);
            })
            .catch((err) => {
              // Restore original profile
              this.current_profile = originalProfile;
              reject(err);
            });
        } else {
          // Restore original profile and reject
          this.current_profile = originalProfile;
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

    // Store original profile to restore later
    const originalProfile = this.current_profile;

    // Change to requested profile
    this.changeProfile(profileIndex);

    if (!this.services['media']) {
      // Restore original profile
      this.current_profile = originalProfile;
      reject(new Error('The device does not support media service.'));
      return;
    }

    // Get profiles from camera using official ONVIF module to get the token
    this.getProfilesFromDevice()
      .then((profiles) => {
        // Get profile at requested profile index
        const profile = profiles[profileIndex] || profiles[0];

        if (!profile || !profile.videoEncoderConfiguration) {
          throw new Error(`No video encoder configuration found for profile ${profileIndex}`);
        }

        // Get the token from the video encoder configuration
        const configToken = profile.videoEncoderConfiguration.$.token;

        if (!configToken) {
          throw new Error('Could not find video encoder configuration token');
        }

        console.log(`\n[ONVIF] Setting video encoder configuration using token: ${configToken}`);

        // Create a copy of the params and add the ConfigurationToken
        let encoderParams = Object.assign({}, params);
        encoderParams.ConfigurationToken = configToken;

        // Use our service to set the configuration
        return this.services['media'].setVideoEncoderConfiguration(encoderParams);
      })
      .then((result) => {
        console.log('\n[ONVIF] Video encoder configuration updated successfully');
        // Restore original profile
        this.current_profile = originalProfile;
        resolve(result);
      })
      .catch((error) => {
        console.error('\n[ONVIF] Error updating video encoder configuration:', error.message);

        // Fallback to using our own profile information
        if (this.current_profile['video']['encoder']) {
          let encoderToken = this.current_profile['video']['encoder']['token'];

          // Create a copy of the params and add the ConfigurationToken
          let encoderParams = Object.assign({}, params);
          encoderParams.ConfigurationToken = encoderToken;

          console.log(`\n[ONVIF] Fallback: Setting video encoder configuration using token: ${encoderToken}`);

          this.services['media']
            .setVideoEncoderConfiguration(encoderParams)
            .then((result) => {
              console.log('\n[ONVIF] Video encoder configuration updated successfully (fallback)');
              // Restore original profile
              this.current_profile = originalProfile;
              resolve(result);
            })
            .catch((err) => {
              console.error('\n[ONVIF] Error updating video encoder configuration (fallback):', err.message);
              // Restore original profile and reject with error
              this.current_profile = originalProfile;
              reject(err);
            });
        } else {
          // Restore original profile and reject with error
          this.current_profile = originalProfile;
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

          // Change to first profile temporarily for imaging options
          this.changeProfile(0);

          // Get imaging options
          const imagingResult = await this.getImagingOptions(0);
          if (imagingResult && imagingResult.data && imagingResult.data.GetOptionsResponse && imagingResult.data.GetOptionsResponse.ImagingOptions) {
            commonImagingOptions = this._parseImagingOptions(imagingResult.data.GetOptionsResponse.ImagingOptions);
          }

          // Get imaging settings
          const imagingSettings = await this.getImagingSettings(0);
          if (imagingSettings && imagingSettings.data && imagingSettings.data.GetImagingSettingsResponse) {
            commonImagingSettings = imagingSettings.data.GetImagingSettingsResponse.ImagingSettings;
          }

          console.log(`\n[ONVIF] Common imaging options and settings retrieved successfully`);
        } catch (error) {
          console.error(`\n[ONVIF] Error getting common imaging options and settings: ${error.message}`);
        }
      }

      // Create an array of promises, one for each profile
      const profilePromises = this.profile_list.map(async (profile, profileIndex) => {
        console.log(`\n[ONVIF] Processing profile ${profileIndex}...`);

        // Prepare result object for this profile
        const capabilities = {
          profile: profileIndex,
          imaging: commonImagingOptions, // Use the common imaging options
          currentImagingSettings: commonImagingSettings, // Use the common imaging settings
          videoEncoder: null,
        };

        try {
          // Change to current profile
          this.changeProfile(profileIndex);

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
                    capabilities.currentVideoEncoderConfiguration = {
                      Encoding: encodingFromProfileList,
                      Resolution: {
                        Width: this.profile_list[profileIndex].video.encoder.resolution?.width || 0,
                        Height: this.profile_list[profileIndex].video.encoder.resolution?.height || 0,
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

      // Process all profiles in parallel and wait for them to complete
      const results = await Promise.all(profilePromises);

      // Filter out null results (skipped or failed profiles)
      const allCapabilities = results.filter((result) => result !== null);

      // Restore original profile
      this.current_profile = originalProfile;

      if (allCapabilities.length === 0) {
        reject(new Error('No H264 or H265 profiles found'));
      } else {
        console.log(`\n[ONVIF] Camera capabilities retrieved successfully for ${allCapabilities.length} H264/H265 profiles`);
        resolve(allCapabilities);
      }
    } catch (error) {
      // Restore original profile
      this.current_profile = originalProfile;
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
