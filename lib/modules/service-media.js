/* ------------------------------------------------------------------
 * node-onvif - service-media.js
 *
 * Copyright (c) 2016 - 2017, Futomi Hatano, All rights reserved.
 * Released under the MIT license
 * Date: 2017-08-26
 * ---------------------------------------------------------------- */
'use strict';
const mUrl = require('url');
const mOnvifSoap = require('./soap.js');

/* ------------------------------------------------------------------
 * Constructor: OnvifServiceMedia(params)
 * - params:
 *    - xaddr   : URL of the entry point for the media service
 *                (Required)
 *    - user  : User name (Optional)
 *    - pass  : Password (Optional)
 *    - time_diff: ms
 * ---------------------------------------------------------------- */
function OnvifServiceMedia(params) {
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
  this.name_space_attr_list = ['xmlns:trt="http://www.onvif.org/ver10/media/wsdl"', 'xmlns:tt="http://www.onvif.org/ver10/schema"'];
}

OnvifServiceMedia.prototype.getRequestParams = function () {
  return Object.assign({}, this.oxaddr, { port: this.port, protocol: this.protocol });
};

OnvifServiceMedia.prototype._createRequestSoap = function (body) {
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
OnvifServiceMedia.prototype.setAuth = function (user, pass) {
  this.user = user || '';
  this.pass = pass || '';
  if (this.user) {
    this.oxaddr.auth = this.user + ':' + this.pass;
  } else {
    this.oxaddr.auth = '';
  }
};

/* ------------------------------------------------------------------
 * Method: getStreamUri(params[, callback])
 * - params:
 *   - ProfileToken | String | required | a token of the profile
 *   - Protocol     | String | required | "UDP", "HTTP", or "RTSP"
 *
 * {
 *   'ProfileToken': 'Profile1',
 *   'Protocol'    : 'UDP'
 * }
 * ---------------------------------------------------------------- */

OnvifServiceMedia.prototype.getStreamUri = function (params, information, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['ProfileToken'], 'string'))) {
      reject(new Error('The "ProfileToken" property was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['Protocol'], 'string'))) {
      reject(new Error('The "Protocol" property was invalid: ' + err_msg));
      return;
    } else if (!params['Protocol'].match(/^(UDP|HTTP|RTSP)$/)) {
      reject(new Error('The "Protocol" property was invalid: The value must be either "UDP", "HTTP", or "RTSP".'));
      return;
    }

    let soap_body = '';
    soap_body += '<trt:GetStreamUri>';
    soap_body += '<trt:StreamSetup>';
    soap_body += '<tt:Stream>RTP-Unicast</tt:Stream>';
    soap_body += '<tt:Transport>';
    soap_body += '<tt:Protocol>' + params['Protocol'] + '</tt:Protocol>';
    soap_body += '</tt:Transport>';
    soap_body += '</trt:StreamSetup>';
    soap_body += '<trt:ProfileToken>' + params['ProfileToken'] + '</trt:ProfileToken>';
    soap_body += '</trt:GetStreamUri>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetStreamUri', soap, information)
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
 * Method: getVideoEncoderConfigurations([callback])
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.getVideoEncoderConfigurations = function (callback) {
  let promise = new Promise((resolve, reject) => {
    let soap_body = '<trt:GetVideoEncoderConfigurations />';
    let soap = this._createRequestSoap(soap_body);
    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetVideoEncoderConfigurations', soap)
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
 * Method: getVideoEncoderConfiguration(params[, callback])
 * - params:
 *   - ConfigurationToken | String | required | a token of the configuration
 *
 * {
 *   'ConfigurationToken': 'Configuration1'
 * }
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.getVideoEncoderConfiguration = function (params, information, callback) {
  // Handle optional information parameter
  if (typeof information === 'function') {
    callback = information;
    information = null;
  }

  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['ConfigurationToken'], 'string'))) {
      reject(new Error('The "ConfigurationToken" property was invalid: ' + err_msg));
      return;
    }

    let soap_body = '';
    soap_body += '<trt:GetVideoEncoderConfiguration>';
    soap_body += '<trt:ConfigurationToken>' + params['ConfigurationToken'] + '</trt:ConfigurationToken>';
    soap_body += '</trt:GetVideoEncoderConfiguration>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetVideoEncoderConfiguration', soap, information)
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
 * Method: getCompatibleVideoEncoderConfigurations(params[, callback])
 * - params:
 *   - ProfileToken | String | required | a token of the profile
 *
 * {
 *   'ProfileToken': 'Profile1'
 * }
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.getCompatibleVideoEncoderConfigurations = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['ProfileToken'], 'string'))) {
      reject(new Error('The "ProfileToken" property was invalid: ' + err_msg));
      return;
    }

    let soap_body = '';
    soap_body += '<trt:GetCompatibleVideoEncoderConfigurations>';
    soap_body += '<trt:ProfileToken>' + params['ProfileToken'] + '</trt:ProfileToken>';
    soap_body += '</trt:GetCompatibleVideoEncoderConfigurations>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetCompatibleVideoEncoderConfigurations', soap)
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
 * Method: getVideoEncoderConfigurationOptions(params[, callback])
 * - params:
 *   - ConfigurationToken | String | optional | Token of the requested configuration
 *   - ProfileToken      | String | optional | Token of the requested profile
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.getVideoEncoderConfigurationOptions = function (params, information, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object', true))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    let soap_body = '';
    soap_body += '<trt:GetVideoEncoderConfigurationOptions>';

    // Add ConfigurationToken if specified
    if (params && 'ConfigurationToken' in params) {
      if ((err_msg = mOnvifSoap.isInvalidValue(params['ConfigurationToken'], 'string'))) {
        reject(new Error('The "ConfigurationToken" property was invalid: ' + err_msg));
        return;
      }
      soap_body += '<trt:ConfigurationToken>' + params['ConfigurationToken'] + '</trt:ConfigurationToken>';
    }

    // Add ProfileToken if specified
    if (params && 'ProfileToken' in params) {
      if ((err_msg = mOnvifSoap.isInvalidValue(params['ProfileToken'], 'string'))) {
        reject(new Error('The "ProfileToken" property was invalid: ' + err_msg));
        return;
      }
      soap_body += '<trt:ProfileToken>' + params['ProfileToken'] + '</trt:ProfileToken>';
    }

    soap_body += '</trt:GetVideoEncoderConfigurationOptions>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetVideoEncoderConfigurationOptions', soap, information)
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
 * Method: getGuaranteedNumberOfVideoEncoderInstances(params[, callback])
 * - params:
 *   - ConfigurationToken | String | required | a token of the configuration
 *
 * {
 *   'ConfigurationToken': 'Configuration1'
 * }
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.getGuaranteedNumberOfVideoEncoderInstances = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['ConfigurationToken'], 'string'))) {
      reject(new Error('The "ConfigurationToken" property was invalid: ' + err_msg));
      return;
    }

    let soap_body = '';
    soap_body += '<trt:GetGuaranteedNumberOfVideoEncoderInstances>';
    soap_body += '<trt:ConfigurationToken>' + params['ConfigurationToken'] + '</trt:ConfigurationToken>';
    soap_body += '</trt:GetGuaranteedNumberOfVideoEncoderInstances>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetGuaranteedNumberOfVideoEncoderInstances', soap)
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
 * Method: getProfiles([callback])
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.getProfiles = function (information, callback) {
  let promise = new Promise((resolve, reject) => {
    let soap_body = '<trt:GetProfiles/>';
    let soap = this._createRequestSoap(soap_body);
    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetProfiles', soap, information)
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
 * Method: getProfile(params[, callback])
 * - params:
 *   - ProfileToken | required | a token of the profile
 *
 * {
 *   'ProfileToken': 'Profile1'
 * }
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.getProfile = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['ProfileToken'], 'string'))) {
      reject(new Error('The "ProfileToken" property was invalid: ' + err_msg));
      return;
    }

    let soap_body = '';
    soap_body += '<trt:GetProfile>';
    soap_body += '<trt:ProfileToken>' + params['ProfileToken'] + '</trt:ProfileToken>';
    soap_body += '</trt:GetProfile>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetProfile', soap)
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
 * Method: createProfile(params[, callback])
 * - params:
 *   - Name  | String | required | a name of the profile
 *   - Token | String | optional | a token of the profile
 *
 * {
 *   'Name: 'TestProfile1'
 * }
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.createProfile = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['Name'], 'string'))) {
      reject(new Error('The "Name" property was invalid: ' + err_msg));
      return;
    }

    if ('Token' in params) {
      if ((err_msg = mOnvifSoap.isInvalidValue(params['Token'], 'string'))) {
        reject(new Error('The "Token" property was invalid: ' + err_msg));
        return;
      }
    }

    let soap_body = '';
    soap_body += '<trt:CreateProfile>';
    soap_body += '<trt:Name>' + params['Name'] + '</trt:Name>';
    if ('Token' in params) {
      soap_body += '<trt:Token>' + params['Token'] + '</trt:Token>';
    }
    soap_body += '</trt:CreateProfile>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'CreateProfile', soap)
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
 * Method: deleteProfile(params[, callback])
 * - params:
 *   - ProfileToken | String | required |
 *
 * {
 *   'ProfileToken: 'TestProfile1'
 * }
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.deleteProfile = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['ProfileToken'], 'string'))) {
      reject(new Error('The "ProfileToken" property was invalid: ' + err_msg));
      return;
    }

    let soap_body = '';
    soap_body += '<trt:DeleteProfile>';
    soap_body += '<trt:ProfileToken>' + params['ProfileToken'] + '</trt:ProfileToken>';
    soap_body += '</trt:DeleteProfile>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'DeleteProfile', soap)
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
 * Method: getVideoSources([callback])
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.getVideoSources = function (callback) {
  let promise = new Promise((resolve, reject) => {
    let soap_body = '<trt:GetVideoSources/>';
    let soap = this._createRequestSoap(soap_body);
    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetVideoSources', soap)
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
 * Method: getVideoSourceConfiguration(params[, callback])
 * - params:
 *   - ConfigurationToken | String | required |
 *
 * {
 *   'ConfigurationToken': 'Profile1'
 * }
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.getVideoSourceConfiguration = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['ConfigurationToken'], 'string'))) {
      reject(new Error('The "ConfigurationToken" property was invalid: ' + err_msg));
      return;
    }

    let soap_body = '';
    soap_body += '<trt:GetVideoSourceConfiguration>';
    soap_body += '<trt:ConfigurationToken>' + params['ConfigurationToken'] + '</trt:ConfigurationToken>';
    soap_body += '</trt:GetVideoSourceConfiguration>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetVideoSourceConfiguration', soap)
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
 * Method: getVideoSourceConfigurations([callback])
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.getVideoSourceConfigurations = function (callback) {
  let promise = new Promise((resolve, reject) => {
    let soap_body = '<trt:GetVideoSourceConfigurations/>';
    let soap = this._createRequestSoap(soap_body);
    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetVideoSourceConfigurations', soap)
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
 * Method: addVideoSourceConfiguration(params[, callback])
 * - params:
 *   - ProfileToken       | String | required | a token of the Profile
 *   - ConfigurationToken | String | required |
 *
 * {
 *   'ProfileToken': 'Profile1'
 *   'ConfigurationToken': 'Profile1'
 * }
 *
 * No device I own does not support this command
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.addVideoSourceConfiguration = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['ProfileToken'], 'string'))) {
      reject(new Error('The "ProfileToken" property was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['ConfigurationToken'], 'string'))) {
      reject(new Error('The "ConfigurationToken" property was invalid: ' + err_msg));
      return;
    }

    let soap_body = '';
    soap_body += '<trt:AddVideoSourceConfiguration>';
    soap_body += '<trt:ProfileToken>' + params['ProfileToken'] + '</trt:ProfileToken>';
    soap_body += '<trt:ConfigurationToken>' + params['ConfigurationToken'] + '</trt:ConfigurationToken>';
    soap_body += '</trt:AddVideoSourceConfiguration>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'AddVideoSourceConfiguration', soap)
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
 * Method: getCompatibleVideoSourceConfigurations(params[, callback])
 * - params:
 *   - ProfileToken | String | required | a token of the targeted PTZ node
 *
 * {
 *   'ProfileToken': 'Profile1'
 * }
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.getCompatibleVideoSourceConfigurations = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['ProfileToken'], 'string'))) {
      reject(new Error('The "ProfileToken" property was invalid: ' + err_msg));
      return;
    }

    let soap_body = '';
    soap_body += '<trt:GetCompatibleVideoSourceConfigurations>';
    soap_body += '<trt:ProfileToken>' + params['ProfileToken'] + '</trt:ProfileToken>';
    soap_body += '</trt:GetCompatibleVideoSourceConfigurations>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetCompatibleVideoSourceConfigurations', soap)
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
 * Method: getVideoSourceConfigurationOptions(params[, callback])
 * - params:
 *   - ProfileToken       | String | optional | a token of the Profile
 *   - ConfigurationToken | String | optional |
 *
 * {
 *   'ProfileToken': 'Profile1'
 *   'ConfigurationToken': 'Conf1'
 * }
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.getVideoSourceConfigurationOptions = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ('ProfileToken' in params) {
      if ((err_msg = mOnvifSoap.isInvalidValue(params['ProfileToken'], 'string'))) {
        reject(new Error('The "ProfileToken" property was invalid: ' + err_msg));
        return;
      }
    }

    if ('ConfigurationToken' in params) {
      if ((err_msg = mOnvifSoap.isInvalidValue(params['ConfigurationToken'], 'string'))) {
        reject(new Error('The "ConfigurationToken" property was invalid: ' + err_msg));
        return;
      }
    }

    let soap_body = '';
    soap_body += '<trt:GetVideoSourceConfigurationOptions>';
    if ('ProfileToken' in params) {
      soap_body += '<trt:ProfileToken>' + params['ProfileToken'] + '</trt:ProfileToken>';
    }
    if ('ConfigurationToken' in params) {
      soap_body += '<trt:ConfigurationToken>' + params['ConfigurationToken'] + '</trt:ConfigurationToken>';
    }
    soap_body += '</trt:GetVideoSourceConfigurationOptions>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetVideoSourceConfigurationOptions', soap)
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
 * Method: getMetadataConfiguration(params[, callback])
 * - params:
 *   - ConfigurationToken | required |
 *
 * {
 *   'ConfigurationToken': 'Conf1'
 * }
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.getMetadataConfiguration = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['ConfigurationToken'], 'string'))) {
      reject(new Error('The "ConfigurationToken" property was invalid: ' + err_msg));
      return;
    }

    let soap_body = '';
    soap_body += '<trt:GetMetadataConfiguration>';
    soap_body += '<trt:ConfigurationToken>' + params['ConfigurationToken'] + '</trt:ConfigurationToken>';
    soap_body += '</trt:GetMetadataConfiguration>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetMetadataConfiguration', soap)
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
 * Method: getMetadataConfigurations([callback])
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.getMetadataConfigurations = function (callback) {
  let promise = new Promise((resolve, reject) => {
    let soap_body = '<trt:GetMetadataConfigurations/>';
    let soap = this._createRequestSoap(soap_body);
    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetMetadataConfigurations', soap)
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
 * Method: addMetadataConfiguration(params[, callback])
 * - params:
 *   - ProfileToken       | String | required | a token of the Profile
 *   - ConfigurationToken | String | required |
 *
 * {
 *   'ProfileToken': 'Profile1'
 *   'ConfigurationToken': 'Conf1'
 * }
 *
 * No device I own does not support this command
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.addMetadataConfiguration = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['ProfileToken'], 'string'))) {
      reject(new Error('The "ProfileToken" property was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['ConfigurationToken'], 'string'))) {
      reject(new Error('The "ConfigurationToken" property was invalid: ' + err_msg));
      return;
    }

    let soap_body = '';
    soap_body += '<trt:AddMetadataConfiguration>';
    soap_body += '<trt:ProfileToken>' + params['ProfileToken'] + '</trt:ProfileToken>';
    soap_body += '<trt:ConfigurationToken>' + params['ConfigurationToken'] + '</trt:ConfigurationToken>';
    soap_body += '</trt:AddMetadataConfiguration>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'AddMetadataConfiguration', soap)
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
 * Method: getCompatibleMetadataConfigurations(params[, callback])
 * - params:
 *   - ProfileToken | String | required | a token of the Profile
 *
 * {
 *   'ProfileToken': 'Profile1'
 * }
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.getCompatibleMetadataConfigurations = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['ProfileToken'], 'string'))) {
      reject(new Error('The "ProfileToken" property was invalid: ' + err_msg));
      return;
    }

    let soap_body = '';
    soap_body += '<trt:GetCompatibleMetadataConfigurations>';
    soap_body += '<trt:ProfileToken>' + params['ProfileToken'] + '</trt:ProfileToken>';
    soap_body += '</trt:GetCompatibleMetadataConfigurations>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetCompatibleMetadataConfigurations', soap)
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
 * Method: getAudioSources([callback])
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.getAudioSources = function (callback) {
  let promise = new Promise((resolve, reject) => {
    let soap_body = '<trt:GetAudioSources/>';
    let soap = this._createRequestSoap(soap_body);
    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetAudioSources', soap)
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
 * Method: getAudioSourceConfiguration(params[, callback])
 * - params:
 *   - ConfigurationToken | String | required |
 *
 * {
 *   'ConfigurationToken': 'Conf1'
 * }
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.getAudioSourceConfiguration = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['ConfigurationToken'], 'string'))) {
      reject(new Error('The "ConfigurationToken" property was invalid: ' + err_msg));
      return;
    }

    let soap_body = '';
    soap_body += '<trt:GetAudioSourceConfiguration>';
    soap_body += '<trt:ConfigurationToken>' + params['ConfigurationToken'] + '</trt:ConfigurationToken>';
    soap_body += '</trt:GetAudioSourceConfiguration>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetAudioSourceConfiguration', soap)
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
 * Method: getAudioSourceConfigurations([callback])
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.getAudioSourceConfigurations = function (callback) {
  let promise = new Promise((resolve, reject) => {
    let soap_body = '<trt:GetAudioSourceConfigurations/>';
    let soap = this._createRequestSoap(soap_body);
    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetAudioSourceConfigurations', soap)
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
 * Method: addAudioSourceConfiguration(params[, callback])
 * - params:
 *   - ProfileToken       | String | required | a token of the Profile
 *   - ConfigurationToken | String | required |
 *
 * {
 *   'ProfileToken': 'Profile1',
 *   'ConfigurationToken': 'Conf1'
 * }
 *
 * No device I own does not support this command
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.addAudioSourceConfiguration = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['ProfileToken'], 'string'))) {
      reject(new Error('The "ProfileToken" property was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['ConfigurationToken'], 'string'))) {
      reject(new Error('The "ConfigurationToken" property was invalid: ' + err_msg));
      return;
    }

    let soap_body = '';
    soap_body += '<trt:AddAudioSourceConfiguration>';
    soap_body += '<trt:ProfileToken>' + params['ProfileToken'] + '</trt:ProfileToken>';
    soap_body += '<trt:ConfigurationToken>' + params['ConfigurationToken'] + '</trt:ConfigurationToken>';
    soap_body += '</trt:AddAudioSourceConfiguration>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'AddAudioSourceConfiguration', soap)
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
 * Method: getCompatibleAudioSourceConfigurations(params[, callback])
 * - params:
 *   - ProfileToken | String | required | a token of the profile
 *
 * {
 *   'ProfileToken': 'Profile1'
 * }
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.getCompatibleAudioSourceConfigurations = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['ProfileToken'], 'string'))) {
      reject(new Error('The "ProfileToken" property was invalid: ' + err_msg));
      return;
    }

    let soap_body = '';
    soap_body += '<trt:GetCompatibleAudioSourceConfigurations>';
    soap_body += '<trt:ProfileToken>' + params['ProfileToken'] + '</trt:ProfileToken>';
    soap_body += '</trt:GetCompatibleAudioSourceConfigurations>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetCompatibleAudioSourceConfigurations', soap)
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
 * Method: getAudioSourceConfigurationOptions(params[, callback])
 * - params:
 *   - ProfileToken       | String | optional | a token of the Profile
 *   - ConfigurationToken | String | optional |
 *
 * {
 *   'ProfileToken': 'Profile1'
 *   'ConfigurationToken': 'Conf1'
 * }
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.getAudioSourceConfigurationOptions = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ('ProfileToken' in params) {
      if ((err_msg = mOnvifSoap.isInvalidValue(params['ProfileToken'], 'string'))) {
        reject(new Error('The "ProfileToken" property was invalid: ' + err_msg));
        return;
      }
    }

    if ('ConfigurationToken' in params) {
      if ((err_msg = mOnvifSoap.isInvalidValue(params['ConfigurationToken'], 'string'))) {
        reject(new Error('The "ConfigurationToken" property was invalid: ' + err_msg));
        return;
      }
    }

    let soap_body = '';
    soap_body += '<trt:GetAudioSourceConfigurationOptions>';
    if ('ProfileToken' in params) {
      soap_body += '<trt:ProfileToken>' + params['ProfileToken'] + '</trt:ProfileToken>';
    }
    if ('ConfigurationToken' in params) {
      soap_body += '<trt:ConfigurationToken>' + params['ConfigurationToken'] + '</trt:ConfigurationToken>';
    }
    soap_body += '</trt:GetAudioSourceConfigurationOptions>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetAudioSourceConfigurationOptions', soap)
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
 * Method: getAudioEncoderConfiguration(params[, callback])
 * - params:
 *   - ConfigurationToken | String | required |
 *
 * {
 *   'ConfigurationToken': 'Profile1'
 * }
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.getAudioEncoderConfiguration = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['ConfigurationToken'], 'string'))) {
      reject(new Error('The "ConfigurationToken" property was invalid: ' + err_msg));
      return;
    }

    let soap_body = '';
    soap_body += '<trt:GetAudioEncoderConfiguration>';
    soap_body += '<trt:ConfigurationToken>' + params['ConfigurationToken'] + '</trt:ConfigurationToken>';
    soap_body += '</trt:GetAudioEncoderConfiguration>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetAudioEncoderConfiguration', soap)
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
 * Method: getAudioEncoderConfigurations([callback])
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.getAudioEncoderConfigurations = function (callback) {
  let promise = new Promise((resolve, reject) => {
    let soap_body = '<trt:GetAudioEncoderConfigurations/>';
    let soap = this._createRequestSoap(soap_body);
    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetAudioEncoderConfigurations', soap)
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
 * Method: addAudioEncoderConfiguration(params[, callback])
 * - params:
 *   - ProfileToken       | String | required | a token of the Profile
 *   - ConfigurationToken | String | required |
 *
 * {
 *   'ProfileToken': 'Profile1',
 *   'ConfigurationToken': 'Conf1'
 * }
 *
 * Not device I own does not support this command
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.addAudioEncoderConfiguration = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['ProfileToken'], 'string'))) {
      reject(new Error('The "ProfileToken" property was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['ConfigurationToken'], 'string'))) {
      reject(new Error('The "ConfigurationToken" property was invalid: ' + err_msg));
      return;
    }

    let soap_body = '';
    soap_body += '<trt:AddAudioEncoderConfiguration>';
    soap_body += '<trt:ProfileToken>' + params['ProfileToken'] + '</trt:ProfileToken>';
    soap_body += '<trt:ConfigurationToken>' + params['ConfigurationToken'] + '</trt:ConfigurationToken>';
    soap_body += '</trt:AddAudioEncoderConfiguration>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'AddAudioEncoderConfiguration', soap)
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
 * Method: getCompatibleAudioEncoderConfigurations(params[, callback])
 * - params:
 *   - ProfileToken | String | required | a token of the profile
 *
 * {
 *   'ProfileToken': 'Profile1'
 * }
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.getCompatibleAudioEncoderConfigurations = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['ProfileToken'], 'string'))) {
      reject(new Error('The "ProfileToken" property was invalid: ' + err_msg));
      return;
    }

    let soap_body = '';
    soap_body += '<trt:GetCompatibleAudioEncoderConfigurations>';
    soap_body += '<trt:ProfileToken>' + params['ProfileToken'] + '</trt:ProfileToken>';
    soap_body += '</trt:GetCompatibleAudioEncoderConfigurations>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetCompatibleAudioEncoderConfigurations', soap)
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
 * Method: getAudioEncoderConfigurationOptions(params[, callback])
 * - params:
 *   - ProfileToken       | String | optional | a token of the Profile
 *   - ConfigurationToken | String | optional |
 *
 * {
 *   'ProfileToken': 'Profile1'
 *   'ConfigurationToken': 'Conf1'
 * }
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.getAudioEncoderConfigurationOptions = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ('ProfileToken' in params) {
      if ((err_msg = mOnvifSoap.isInvalidValue(params['ProfileToken'], 'string'))) {
        reject(new Error('The "ProfileToken" property was invalid: ' + err_msg));
        return;
      }
    }

    if ('ConfigurationToken' in params) {
      if ((err_msg = mOnvifSoap.isInvalidValue(params['ConfigurationToken'], 'string'))) {
        reject(new Error('The "ConfigurationToken" property was invalid: ' + err_msg));
        return;
      }
    }

    let soap_body = '';
    soap_body += '<trt:GetAudioEncoderConfigurationOptions>';
    if ('ProfileToken' in params) {
      soap_body += '<trt:ProfileToken>' + params['ProfileToken'] + '</trt:ProfileToken>';
    }
    if ('ConfigurationToken' in params) {
      soap_body += '<trt:ConfigurationToken>' + params['ConfigurationToken'] + '</trt:ConfigurationToken>';
    }
    soap_body += '</trt:GetAudioEncoderConfigurationOptions>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetAudioEncoderConfigurationOptions', soap)
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
 * Method: startMulticastStreaming(params[, callback])
 * - params:
 *   - ProfileToken | String | required | a token of the Profile
 *
 * {
 *   'ProfileToken': 'Profile1'
 * }
 *
 * No device I own does not support this command
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.startMulticastStreaming = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['ProfileToken'], 'string'))) {
      reject(new Error('The "ProfileToken" property was invalid: ' + err_msg));
      return;
    }

    let soap_body = '';
    soap_body += '<trt:StartMulticastStreaming>';
    soap_body += '<trt:ProfileToken>' + params['ProfileToken'] + '</trt:ProfileToken>';
    soap_body += '</trt:StartMulticastStreaming>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'StartMulticastStreaming', soap)
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
 * Method: stopMulticastStreaming(params[, callback])
 * - params:
 *   - ProfileToken | String | required | a token of the Profile
 *
 * {
 *   'ProfileToken': 'Profile1'
 * }
 *
 * No device I own does not support this command
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.stopMulticastStreaming = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['ProfileToken'], 'string'))) {
      reject(new Error('The "ProfileToken" property was invalid: ' + err_msg));
      return;
    }

    let soap_body = '';
    soap_body += '<trt:StopMulticastStreaming>';
    soap_body += '<trt:ProfileToken>' + params['ProfileToken'] + '</trt:ProfileToken>';
    soap_body += '</trt:StopMulticastStreaming>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'StopMulticastStreaming', soap)
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
 * Method: getSnapshotUri(params[, callback])
 * - params:
 *   - ProfileToken | String | required | a token of the Profile
 *
 * {
 *   'ProfileToken': 'Profile1'
 * }
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.getSnapshotUri = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ((err_msg = mOnvifSoap.isInvalidValue(params['ProfileToken'], 'string'))) {
      reject(new Error('The "ProfileToken" property was invalid: ' + err_msg));
      return;
    }

    let soap_body = '';
    soap_body += '<trt:GetSnapshotUri>';
    soap_body += '<trt:ProfileToken>' + params['ProfileToken'] + '</trt:ProfileToken>';
    soap_body += '</trt:GetSnapshotUri>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetSnapshotUri', soap)
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
 * Method: getMetadataConfigurationOptions(params[, callback])
 * - params:
 *   - ProfileToken       | String | optional | a token of the Profile
 *   - ConfigurationToken | String | optional |
 *
 * {
 *   'ProfileToken': 'Profile1'
 *   'ConfigurationToken': 'Conf1'
 * }
 * ---------------------------------------------------------------- */
OnvifServiceMedia.prototype.getMetadataConfigurationOptions = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if ('ProfileToken' in params) {
      if ((err_msg = mOnvifSoap.isInvalidValue(params['ProfileToken'], 'string'))) {
        reject(new Error('The "ProfileToken" property was invalid: ' + err_msg));
        return;
      }
    }

    if ('ConfigurationToken' in params) {
      if ((err_msg = mOnvifSoap.isInvalidValue(params['ConfigurationToken'], 'string'))) {
        reject(new Error('The "ConfigurationToken" property was invalid: ' + err_msg));
        return;
      }
    }

    let soap_body = '';
    soap_body += '<trt:GetMetadataConfigurationOptions>';
    if ('ProfileToken' in params) {
      soap_body += '<trt:ProfileToken>' + params['ProfileToken'] + '</trt:ProfileToken>';
    }
    if ('ConfigurationToken' in params) {
      soap_body += '<trt:ConfigurationToken>' + params['ConfigurationToken'] + '</trt:ConfigurationToken>';
    }
    soap_body += '</trt:GetMetadataConfigurationOptions>';
    let soap = this._createRequestSoap(soap_body);

    mOnvifSoap
      .requestCommand(this.getRequestParams(), 'GetMetadataConfigurationOptions', soap)
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
 * Method: setVideoEncoderConfiguration(params[, callback])
 * - params:
 *   - ConfigurationToken | String | required | Token of the configuration
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
OnvifServiceMedia.prototype.setVideoEncoderConfiguration = function (params, callback) {
  let promise = new Promise((resolve, reject) => {
    let err_msg = '';
    if ((err_msg = mOnvifSoap.isInvalidValue(params, 'object'))) {
      reject(new Error('The value of "params" was invalid: ' + err_msg));
      return;
    }

    if (!params['ConfigurationToken']) {
      reject(new Error('The "ConfigurationToken" property is required.'));
      return;
    }

    // Get the current configuration first to merge with the new settings
    this.getVideoEncoderConfiguration({ ConfigurationToken: params['ConfigurationToken'] })
      .then((result) => {
        if (!result || !result.data || !result.data.GetVideoEncoderConfigurationResponse || !result.data.GetVideoEncoderConfigurationResponse.Configuration) {
          throw new Error('Failed to get current video encoder configuration');
        }

        // Get the current configuration
        const currentConfig = result.data.GetVideoEncoderConfigurationResponse.Configuration;

        // Start building the SOAP body
        let soap_body = '';
        soap_body += '<trt:SetVideoEncoderConfiguration>';
        soap_body += '<trt:Configuration token="' + params['ConfigurationToken'] + '">';

        // Name (use current one)
        soap_body += '<tt:Name>' + currentConfig.Name + '</tt:Name>';

        // Use token from current config
        soap_body += '<tt:UseCount>' + (currentConfig.UseCount || 0) + '</tt:UseCount>';

        // Source token (use current one)
        if (currentConfig.SourceToken) {
          soap_body += '<tt:SourceToken>' + currentConfig.SourceToken + '</tt:SourceToken>';
        }

        // Guaranteed frame rate (use current one)
        soap_body += '<tt:GuaranteedFrameRate>' + (currentConfig.GuaranteedFrameRate || 'false') + '</tt:GuaranteedFrameRate>';

        // Resolution
        soap_body += '<tt:Resolution>';
        if (params.Resolution && typeof params.Resolution === 'object') {
          if (params.Resolution.Width !== undefined) {
            soap_body += '<tt:Width>' + params.Resolution.Width + '</tt:Width>';
          } else {
            soap_body += '<tt:Width>' + (currentConfig.Resolution ? currentConfig.Resolution.Width : 1920) + '</tt:Width>';
          }

          if (params.Resolution.Height !== undefined) {
            soap_body += '<tt:Height>' + params.Resolution.Height + '</tt:Height>';
          } else {
            soap_body += '<tt:Height>' + (currentConfig.Resolution ? currentConfig.Resolution.Height : 1080) + '</tt:Height>';
          }
        } else {
          // Use current resolution if not provided
          soap_body += '<tt:Width>' + (currentConfig.Resolution ? currentConfig.Resolution.Width : 1920) + '</tt:Width>';
          soap_body += '<tt:Height>' + (currentConfig.Resolution ? currentConfig.Resolution.Height : 1080) + '</tt:Height>';
        }
        soap_body += '</tt:Resolution>';

        // Quality
        if (params.Quality !== undefined) {
          soap_body += '<tt:Quality>' + params.Quality + '</tt:Quality>';
        } else {
          soap_body += '<tt:Quality>' + (currentConfig.Quality || 4) + '</tt:Quality>';
        }

        // Encoding
        if (params.Encoding) {
          if (['JPEG', 'MPEG4', 'H264'].indexOf(params.Encoding) === -1) {
            reject(new Error('Invalid Encoding. Must be one of: JPEG, MPEG4, H264'));
            return;
          }
          soap_body += '<tt:Encoding>' + params.Encoding + '</tt:Encoding>';
        } else {
          soap_body += '<tt:Encoding>' + (currentConfig.Encoding || 'H264') + '</tt:Encoding>';
        }

        // Frame rate
        if (params.FrameRate !== undefined) {
          soap_body += '<tt:RateControl>';
          soap_body += '<tt:FrameRateLimit>' + params.FrameRate + '</tt:FrameRateLimit>';

          // EncodingInterval
          if (params.EncodingInterval !== undefined) {
            soap_body += '<tt:EncodingInterval>' + params.EncodingInterval + '</tt:EncodingInterval>';
          } else if (currentConfig.RateControl && currentConfig.RateControl.EncodingInterval) {
            soap_body += '<tt:EncodingInterval>' + currentConfig.RateControl.EncodingInterval + '</tt:EncodingInterval>';
          } else {
            soap_body += '<tt:EncodingInterval>1</tt:EncodingInterval>';
          }

          // Bitrate
          if (params.Bitrate !== undefined) {
            soap_body += '<tt:BitrateLimit>' + params.Bitrate + '</tt:BitrateLimit>';
          } else if (currentConfig.RateControl && currentConfig.RateControl.BitrateLimit) {
            soap_body += '<tt:BitrateLimit>' + currentConfig.RateControl.BitrateLimit + '</tt:BitrateLimit>';
          } else {
            soap_body += '<tt:BitrateLimit>3000</tt:BitrateLimit>';
          }

          soap_body += '</tt:RateControl>';
        } else if (params.Bitrate !== undefined) {
          soap_body += '<tt:RateControl>';

          if (currentConfig.RateControl && currentConfig.RateControl.FrameRateLimit) {
            soap_body += '<tt:FrameRateLimit>' + currentConfig.RateControl.FrameRateLimit + '</tt:FrameRateLimit>';
          } else {
            soap_body += '<tt:FrameRateLimit>30</tt:FrameRateLimit>';
          }

          // EncodingInterval
          if (params.EncodingInterval !== undefined) {
            soap_body += '<tt:EncodingInterval>' + params.EncodingInterval + '</tt:EncodingInterval>';
          } else if (currentConfig.RateControl && currentConfig.RateControl.EncodingInterval) {
            soap_body += '<tt:EncodingInterval>' + currentConfig.RateControl.EncodingInterval + '</tt:EncodingInterval>';
          } else {
            soap_body += '<tt:EncodingInterval>1</tt:EncodingInterval>';
          }

          soap_body += '<tt:BitrateLimit>' + params.Bitrate + '</tt:BitrateLimit>';
          soap_body += '</tt:RateControl>';
        } else if (currentConfig.RateControl) {
          soap_body += '<tt:RateControl>';
          soap_body += '<tt:FrameRateLimit>' + (currentConfig.RateControl.FrameRateLimit || 30) + '</tt:FrameRateLimit>';

          // EncodingInterval
          if (params.EncodingInterval !== undefined) {
            soap_body += '<tt:EncodingInterval>' + params.EncodingInterval + '</tt:EncodingInterval>';
          } else if (currentConfig.RateControl && currentConfig.RateControl.EncodingInterval) {
            soap_body += '<tt:EncodingInterval>' + currentConfig.RateControl.EncodingInterval + '</tt:EncodingInterval>';
          } else {
            soap_body += '<tt:EncodingInterval>1</tt:EncodingInterval>';
          }

          soap_body += '<tt:BitrateLimit>' + (currentConfig.RateControl.BitrateLimit || 3000) + '</tt:BitrateLimit>';
          soap_body += '</tt:RateControl>';
        }

        // H264 Configuration
        if (params.Encoding === 'H264' || currentConfig.Encoding === 'H264') {
          soap_body += '<tt:H264>';

          // Gov Length
          if (params.GovLength !== undefined) {
            soap_body += '<tt:GovLength>' + params.GovLength + '</tt:GovLength>';
          } else if (params.H264 && params.H264.GovLength !== undefined) {
            soap_body += '<tt:GovLength>' + params.H264.GovLength + '</tt:GovLength>';
          } else if (currentConfig.H264 && currentConfig.H264.GovLength) {
            soap_body += '<tt:GovLength>' + currentConfig.H264.GovLength + '</tt:GovLength>';
          } else {
            soap_body += '<tt:GovLength>30</tt:GovLength>'; // Default value
          }

          // H264 Profile
          if (params.H264 && params.H264.H264Profile) {
            if (['Baseline', 'Main', 'Extended', 'High'].indexOf(params.H264.H264Profile) === -1) {
              reject(new Error('Invalid H264Profile. Must be one of: Baseline, Main, Extended, High'));
              return;
            }
            soap_body += '<tt:H264Profile>' + params.H264.H264Profile + '</tt:H264Profile>';
          } else if (currentConfig.H264 && currentConfig.H264.H264Profile) {
            soap_body += '<tt:H264Profile>' + currentConfig.H264.H264Profile + '</tt:H264Profile>';
          } else {
            soap_body += '<tt:H264Profile>Main</tt:H264Profile>'; // Default value
          }

          soap_body += '</tt:H264>';
        }

        // Multicast configuration (use current)
        if (currentConfig.Multicast) {
          soap_body += '<tt:Multicast>';

          if (currentConfig.Multicast.Address) {
            soap_body += '<tt:Address>';

            if (currentConfig.Multicast.Address.Type) {
              soap_body += '<tt:Type>' + currentConfig.Multicast.Address.Type + '</tt:Type>';
            }

            if (currentConfig.Multicast.Address.IPv4Address) {
              soap_body += '<tt:IPv4Address>' + currentConfig.Multicast.Address.IPv4Address + '</tt:IPv4Address>';
            }

            soap_body += '</tt:Address>';
          }

          if (currentConfig.Multicast.Port) {
            soap_body += '<tt:Port>' + currentConfig.Multicast.Port + '</tt:Port>';
          }

          if (currentConfig.Multicast.TTL) {
            soap_body += '<tt:TTL>' + currentConfig.Multicast.TTL + '</tt:TTL>';
          }

          if (currentConfig.Multicast.AutoStart !== undefined) {
            soap_body += '<tt:AutoStart>' + currentConfig.Multicast.AutoStart + '</tt:AutoStart>';
          }

          soap_body += '</tt:Multicast>';
        }

        // SessionTimeout (use current)
        if (currentConfig.SessionTimeout) {
          soap_body += '<tt:SessionTimeout>' + currentConfig.SessionTimeout + '</tt:SessionTimeout>';
        }

        soap_body += '</trt:Configuration>';
        soap_body += '</trt:SetVideoEncoderConfiguration>';

        let soap = this._createRequestSoap(soap_body);

        return mOnvifSoap.requestCommand(this.getRequestParams(), 'SetVideoEncoderConfiguration', soap);
      })
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

module.exports = OnvifServiceMedia;
