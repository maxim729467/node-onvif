/* ------------------------------------------------------------------
 * node-onvif - service-imaging.js
 *
 * Copyright (c) 2024, All rights reserved.
 * Released under the MIT license
 * Date: 2024-07-15
 * ---------------------------------------------------------------- */
'use strict';
const mUrl = require('url');
const mOnvifSoap = require('./soap.js');

/* ------------------------------------------------------------------
 * Constructor: OnvifServiceImaging(params)
 * - params:
 *    - xaddr   : URL of the entry point for the imaging service
 *                (Required)
 *    - user  : User name (Optional)
 *    - pass  : Password (Optional)
 *    - time_diff: ms
 * ---------------------------------------------------------------- */
function OnvifServiceImaging(params) {
  this.xaddr = '';
  this.user = '';
  this.pass = '';
  this.port = params.port;
  this.protocol = params.protocol;

  let err_msg = '';

  if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
    throw new Error('The value of "params" was invalid: ' + err_msg);
  }

  if ('xaddr' in params) {
    if ((err_msg = mOnvifSoap.isInvalidValue(params['xaddr'], 'string'))) {
      throw new Error('The "xaddr" property was invalid: ' + err_msg);
    } else {
      this.xaddr = params['xaddr'];
    }
  } else {
    throw new Error('The "xaddr" property is required.');
  }

  if ('user' in params) {
    if ((err_msg = mOnvifSoap.isInvalidValue(params['user'], 'string', true))) {
      throw new Error('The "user" property was invalid: ' + err_msg);
    } else {
      this.user = params['user'] || '';
    }
  }

  if ('pass' in params) {
    if ((err_msg = mOnvifSoap.isInvalidValue(params['pass'], 'string', true))) {
      throw new Error('The "pass" property was invalid: ' + err_msg);
    } else {
      this.pass = params['pass'] || '';
    }
  }

  this.oxaddr = mUrl.parse(this.xaddr);
  if (this.user) {
    this.oxaddr.auth = this.user + ':' + this.pass;
  }

  this.time_diff = params['time_diff'];
  this.name_space_attr_list = [
    'xmlns:ter="http://www.onvif.org/ver10/error"',
    'xmlns:xs="http://www.w3.org/2001/XMLSchema"',
    'xmlns:tt="http://www.onvif.org/ver10/schema"',
    'xmlns:timg="http://www.onvif.org/ver20/imaging/wsdl"',
  ];
}

OnvifServiceImaging.prototype.getRequestParams = function () {
  return Object.assign({}, this.oxaddr, { port: this.port, protocol: this.protocol });
};

OnvifServiceImaging.prototype._createRequestSoap = function (body) {
  let soap = mOnvifSoap.createRequestSoap({
    body: body,
    xmlns: this.name_space_attr_list,
    diff: this.time_diff,
    user: this.user,
    pass: this.pass,
  });
  return soap;
};

/* ------------------------------------------------------------------
 * Method: setAuth(user, pass)
 * ---------------------------------------------------------------- */
OnvifServiceImaging.prototype.setAuth = function (user, pass) {
  this.user = user || '';
  this.pass = pass || '';
  if (this.user) {
    this.oxaddr.auth = this.user + ':' + this.pass;
  } else {
    this.oxaddr.auth = '';
  }
};

/* ------------------------------------------------------------------
 * Method: getImagingSettings(params[, callback])
 * - params:
 *   - VideoSourceToken | String | required | Token of the video source
 * ---------------------------------------------------------------- */
OnvifServiceImaging.prototype.getImagingSettings = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['VideoSourceToken'], 'string'))) {
      reject(new Error('The "VideoSourceToken" property was invalid: ' + err_msg));
      return;
    }

    let soap_body = '';
    soap_body += '<timg:GetImagingSettings>';
    soap_body += '<timg:VideoSourceToken>' + params['VideoSourceToken'] + '</timg:VideoSourceToken>';
    soap_body += '</timg:GetImagingSettings>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetImagingSettings', soap)
      .then((result) => {
        resolve(result);
      })
      .catch((error) => {
        reject(error);
      });
  });
  if (callback) {
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
 * Method: setImagingSettings(params[, callback])
 * - params:
 *   - VideoSourceToken | String | required | Token of the video source
 *   - Brightness       | Float  | optional | Brightness (0 to 100)
 *   - ColorSaturation  | Float  | optional | Color saturation (0 to 100)
 *   - Contrast         | Float  | optional | Contrast (0 to 100)
 *   - Sharpness        | Float  | optional | Sharpness (0 to 100)
 *   - FocusMode        | String | optional | 'AUTO' or 'MANUAL'
 *   - FocusDistance    | Float  | optional | Focus distance (only if FocusMode=MANUAL)
 *   - Iris             | Float  | optional | Iris (0 to 100)
 *   - AutoFocusMode    | String | optional | 'AUTO' or 'MANUAL'
 *   - BacklightCompensation:
 *     - Mode           | String | optional | 'ON' or 'OFF'
 *     - Level          | Float  | optional | Backlight compensation level (0 to 100)
 *   - WideDynamicRange:
 *     - Mode           | String | optional | 'ON' or 'OFF'
 *     - Level          | Float  | optional | Wide dynamic range level (0 to 100)
 *   - WhiteBalance:
 *     - Mode           | String | optional | 'AUTO' or 'MANUAL'
 *     - CbGain         | Float  | optional | Cb gain (only if Mode=MANUAL)
 *     - CrGain         | Float  | optional | Cr gain (only if Mode=MANUAL)
 * ---------------------------------------------------------------- */
OnvifServiceImaging.prototype.setImagingSettings = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['VideoSourceToken'], 'string'))) {
      reject(new Error('The "VideoSourceToken" property was invalid: ' + err_msg));
      return;
    }

    // Log the parameters for debugging
    console.log('\n[ONVIF] Processing settings:', JSON.stringify(params, null, 2));

    let soap_body = '';
    soap_body += '<timg:SetImagingSettings>';
    soap_body += '<timg:VideoSourceToken>' + params['VideoSourceToken'] + '</timg:VideoSourceToken>';
    soap_body += '<timg:ImagingSettings>';

    // Brightness
    if ('Brightness' in params) {
      if ((err_msg = mOnvifSoap.isInvalidValue(params['Brightness'], 'float'))) {
        reject(new Error('The "Brightness" property was invalid: ' + err_msg));
        return;
      }
      soap_body += '<tt:Brightness>' + params['Brightness'] + '</tt:Brightness>';
    }

    // ColorSaturation
    if ('ColorSaturation' in params) {
      if ((err_msg = mOnvifSoap.isInvalidValue(params['ColorSaturation'], 'float'))) {
        reject(new Error('The "ColorSaturation" property was invalid: ' + err_msg));
        return;
      }
      soap_body += '<tt:ColorSaturation>' + params['ColorSaturation'] + '</tt:ColorSaturation>';
    }

    // Contrast
    if ('Contrast' in params) {
      if ((err_msg = mOnvifSoap.isInvalidValue(params['Contrast'], 'float'))) {
        reject(new Error('The "Contrast" property was invalid: ' + err_msg));
        return;
      }
      soap_body += '<tt:Contrast>' + params['Contrast'] + '</tt:Contrast>';
    }

    // Sharpness
    if ('Sharpness' in params) {
      if ((err_msg = mOnvifSoap.isInvalidValue(params['Sharpness'], 'float'))) {
        reject(new Error('The "Sharpness" property was invalid: ' + err_msg));
        return;
      }
      soap_body += '<tt:Sharpness>' + params['Sharpness'] + '</tt:Sharpness>';
    }

    // Focus
    if ('FocusMode' in params || 'FocusDistance' in params) {
      soap_body += '<tt:Focus>';

      if ('FocusMode' in params) {
        if (params['FocusMode'] !== 'AUTO' && params['FocusMode'] !== 'MANUAL') {
          reject(new Error('The "FocusMode" property must be "AUTO" or "MANUAL".'));
          return;
        }
        soap_body += '<tt:Mode>' + params['FocusMode'] + '</tt:Mode>';
      }

      if ('FocusDistance' in params) {
        if ((err_msg = mOnvifSoap.isInvalidValue(params['FocusDistance'], 'float'))) {
          reject(new Error('The "FocusDistance" property was invalid: ' + err_msg));
          return;
        }
        soap_body += '<tt:DefaultSpeed>' + params['FocusDistance'] + '</tt:DefaultSpeed>';
      }

      soap_body += '</tt:Focus>';
    }

    // Iris
    if ('Iris' in params) {
      if ((err_msg = mOnvifSoap.isInvalidValue(params['Iris'], 'float'))) {
        reject(new Error('The "Iris" property was invalid: ' + err_msg));
        return;
      }
      soap_body += '<tt:Iris>' + params['Iris'] + '</tt:Iris>';
    }

    // AutoFocus
    if ('AutoFocusMode' in params) {
      if (params['AutoFocusMode'] !== 'AUTO' && params['AutoFocusMode'] !== 'MANUAL') {
        reject(new Error('The "AutoFocusMode" property must be "AUTO" or "MANUAL".'));
        return;
      }
      soap_body += '<tt:AutoFocus>';
      soap_body += '<tt:Mode>' + params['AutoFocusMode'] + '</tt:Mode>';
      soap_body += '</tt:AutoFocus>';
    }

    // BacklightCompensation
    if ('BacklightCompensation' in params) {
      let blc = params['BacklightCompensation'];
      if (typeof blc !== 'object') {
        reject(new Error('The "BacklightCompensation" property must be an object.'));
        return;
      }
      soap_body += '<tt:BacklightCompensation>';

      if ('Mode' in blc) {
        if (blc['Mode'] !== 'ON' && blc['Mode'] !== 'OFF') {
          reject(new Error('The "Mode" property in the "BacklightCompensation" must be "ON" or "OFF".'));
          return;
        }
        soap_body += '<tt:Mode>' + blc['Mode'] + '</tt:Mode>';
      }

      if ('Level' in blc) {
        if ((err_msg = mOnvifSoap.isInvalidValue(blc['Level'], 'float'))) {
          reject(new Error('The "Level" property in the "BacklightCompensation" was invalid: ' + err_msg));
          return;
        }
        soap_body += '<tt:Level>' + blc['Level'] + '</tt:Level>';
      }

      soap_body += '</tt:BacklightCompensation>';
    }

    // WideDynamicRange
    if ('WideDynamicRange' in params) {
      let wdr = params['WideDynamicRange'];
      if (typeof wdr !== 'object') {
        reject(new Error('The "WideDynamicRange" property must be an object.'));
        return;
      }
      soap_body += '<tt:WideDynamicRange>';

      if ('Mode' in wdr) {
        if (wdr['Mode'] !== 'ON' && wdr['Mode'] !== 'OFF') {
          reject(new Error('The "Mode" property in the "WideDynamicRange" must be "ON" or "OFF".'));
          return;
        }
        soap_body += '<tt:Mode>' + wdr['Mode'] + '</tt:Mode>';
      }

      if ('Level' in wdr) {
        if ((err_msg = mOnvifSoap.isInvalidValue(wdr['Level'], 'float'))) {
          reject(new Error('The "Level" property in the "WideDynamicRange" was invalid: ' + err_msg));
          return;
        }
        soap_body += '<tt:Level>' + wdr['Level'] + '</tt:Level>';
      }

      soap_body += '</tt:WideDynamicRange>';
    }

    // WhiteBalance
    if ('WhiteBalance' in params) {
      let wb = params['WhiteBalance'];
      if (typeof wb !== 'object') {
        reject(new Error('The "WhiteBalance" property must be an object.'));
        return;
      }
      soap_body += '<tt:WhiteBalance>';

      if ('Mode' in wb) {
        if (wb['Mode'] !== 'AUTO' && wb['Mode'] !== 'MANUAL') {
          reject(new Error('The "Mode" property in the "WhiteBalance" must be "AUTO" or "MANUAL".'));
          return;
        }
        soap_body += '<tt:Mode>' + wb['Mode'] + '</tt:Mode>';
      }

      if ('CbGain' in wb) {
        if ((err_msg = mOnvifSoap.isInvalidValue(wb['CbGain'], 'float'))) {
          reject(new Error('The "CbGain" property in the "WhiteBalance" was invalid: ' + err_msg));
          return;
        }
        soap_body += '<tt:CbGain>' + wb['CbGain'] + '</tt:CbGain>';
      }

      if ('CrGain' in wb) {
        if ((err_msg = mOnvifSoap.isInvalidValue(wb['CrGain'], 'float'))) {
          reject(new Error('The "CrGain" property in the "WhiteBalance" was invalid: ' + err_msg));
          return;
        }
        soap_body += '<tt:CrGain>' + wb['CrGain'] + '</tt:CrGain>';
      }

      soap_body += '</tt:WhiteBalance>';
    }

    soap_body += '</timg:ImagingSettings>';
    soap_body += '</timg:SetImagingSettings>';

    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'SetImagingSettings', soap)
      .then((result) => {
        resolve(result);
      })
      .catch((error) => {
        // Properly format the error message
        let errorMessage = '';
        if (typeof error === 'object') {
          errorMessage = error.message || JSON.stringify(error);
        } else {
          errorMessage = error.toString();
        }
        console.error('\n[ONVIF] SetImagingSettings error:', errorMessage);
        reject(new Error(errorMessage));
      });
  });
  if (callback) {
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
 * Method: getOptions(params[, callback])
 * - params:
 *   - VideoSourceToken | String | required | Token of the video source
 * ---------------------------------------------------------------- */
OnvifServiceImaging.prototype.getOptions = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['VideoSourceToken'], 'string'))) {
      reject(new Error('The "VideoSourceToken" property was invalid: ' + err_msg));
      return;
    }

    let soap_body = '';
    soap_body += '<timg:GetOptions>';
    soap_body += '<timg:VideoSourceToken>' + params['VideoSourceToken'] + '</timg:VideoSourceToken>';
    soap_body += '</timg:GetOptions>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetOptions', soap)
      .then((result) => {
        resolve(result);
      })
      .catch((error) => {
        reject(error);
      });
  });
  if (callback) {
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
 * Method: move(params[, callback])
 * - params:
 *   - VideoSourceToken | String | required | Token of the video source
 *   - Focus            | Object | required | Focus parameters
 *     - Continuous     | Object | required | Continuous focus movement
 *       - Speed        | Float  | required | Speed of movement (negative = outward, positive = inward)
 * ---------------------------------------------------------------- */
OnvifServiceImaging.prototype.move = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['VideoSourceToken'], 'string'))) {
      reject(new Error('The "VideoSourceToken" property was invalid: ' + err_msg));
      return;
    }

    if (!('Focus' in params) || typeof params['Focus'] !== 'object') {
      reject(new Error('The "Focus" property is required and must be an object.'));
      return;
    }

    let focus = params['Focus'];
    if (!('Continuous' in focus) || typeof focus['Continuous'] !== 'object') {
      reject(new Error('The "Continuous" property in the "Focus" is required and must be an object.'));
      return;
    }

    let continuous = focus['Continuous'];
    if (!('Speed' in continuous)) {
      reject(new Error('The "Speed" property in the "Continuous" is required.'));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(continuous['Speed'], 'float'))) {
      reject(new Error('The "Speed" property was invalid: ' + err_msg));
      return;
    }

    let soap_body = '';
    soap_body += '<timg:Move>';
    soap_body += '<timg:VideoSourceToken>' + params['VideoSourceToken'] + '</timg:VideoSourceToken>';
    soap_body += '<timg:Focus>';
    soap_body += '<timg:Continuous>';
    soap_body += '<timg:Speed>' + continuous['Speed'] + '</timg:Speed>';
    soap_body += '</timg:Continuous>';
    soap_body += '</timg:Focus>';
    soap_body += '</timg:Move>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'Move', soap)
      .then((result) => {
        resolve(result);
      })
      .catch((error) => {
        reject(error);
      });
  });
  if (callback) {
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
 * Method: stop(params[, callback])
 * - params:
 *   - VideoSourceToken | String | required | Token of the video source
 * ---------------------------------------------------------------- */
OnvifServiceImaging.prototype.stop = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['VideoSourceToken'], 'string'))) {
      reject(new Error('The "VideoSourceToken" property was invalid: ' + err_msg));
      return;
    }

    let soap_body = '';
    soap_body += '<timg:Stop>';
    soap_body += '<timg:VideoSourceToken>' + params['VideoSourceToken'] + '</timg:VideoSourceToken>';
    soap_body += '</timg:Stop>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'Stop', soap)
      .then((result) => {
        resolve(result);
      })
      .catch((error) => {
        reject(error);
      });
  });
  if (callback) {
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
 * Method: getStatus(params[, callback])
 * - params:
 *   - VideoSourceToken | String | required | Token of the video source
 * ---------------------------------------------------------------- */
OnvifServiceImaging.prototype.getStatus = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['VideoSourceToken'], 'string'))) {
      reject(new Error('The "VideoSourceToken" property was invalid: ' + err_msg));
      return;
    }

    let soap_body = '';
    soap_body += '<timg:GetStatus>';
    soap_body += '<timg:VideoSourceToken>' + params['VideoSourceToken'] + '</timg:VideoSourceToken>';
    soap_body += '</timg:GetStatus>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetStatus', soap)
      .then((result) => {
        resolve(result);
      })
      .catch((error) => {
        reject(error);
      });
  });
  if (callback) {
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

module.exports = OnvifServiceImaging;
