/* ------------------------------------------------------------------
* node-onvif - soap.js
*
* Copyright (c) 2016-2018, Futomi Hatano, All rights reserved.
* Released under the MIT license
* Date: 2018-08-13
* ---------------------------------------------------------------- */
'use strict';
const axios = require('axios');
const mXml2Js = require('xml2js');
const mHttp   = require('http');
const mHttps   = require('https');
const https   = require('https');
const mCrypto = require('crypto');
const moment = require('moment');
let mHtml   = null;
try {
	mHtml   = require('html');
} catch(e) {}

/* ------------------------------------------------------------------
* Constructor: OnvifSoap()
* ---------------------------------------------------------------- */
function OnvifSoap() {
	this.HTTP_TIMEOUT = 3000; // ms
}

/* ------------------------------------------------------------------
* Method: parse(soap)
* ---------------------------------------------------------------- */
OnvifSoap.prototype.parse = function(soap) {
	let promise = new Promise((resolve, reject) => {
		let opts = {
			'explicitRoot'     : false,
			'explicitArray'    : false,
			'ignoreAttrs'      : false, // Never change to `true`
			'tagNameProcessors': [function(name) {
				let m = name.match(/^([^\:]+)\:([^\:]+)$/);
				return (m ? m[2] : name);
			}]
		};
		mXml2Js.parseString(soap, opts, (error, result) => {
			if(error) {
				reject(error);
			} else {
				resolve(result);
			}
		});
	});
	return promise;
};

/* ------------------------------------------------------------------
* Method: requestCommand(oxaddr, method_name, soap)
* ---------------------------------------------------------------- */
OnvifSoap.prototype.requestCommand = function(oxaddr, method_name, soap, information) {
	let promise = new Promise((resolve, reject) => {

		let xml = '';
		this
			._request(oxaddr, soap, method_name, information)
			.then((res) => {
			xml = res;
			return this.parse(xml);
		})
			.then((result) => {
			let fault = this._getFaultReason(result);
			if(fault) {
				let err = new Error(fault);
				reject(err);
			} else {
				let parsed = this._parseResponseResult(method_name, result);
				if(parsed) {
					let res = {
						'soap'     : xml,
						'formatted': mHtml ? mHtml.prettyPrint(xml, {indent_size: 2}) : '',
						'converted': result,
						'data': parsed
					};
					resolve(res);
				} else {
					let err = new Error('The device seems to not support the ' + method_name + '() method.');
					reject(err);
				}
			}
		})
			.catch((error) => {
			reject(error);
		});
	});
	return promise;
};

OnvifSoap.prototype._parseResponseResult = function(method_name, res) {
	let s0 = res['Body'];
	if(!s0) {return null;}
	if((method_name + 'Response') in s0) {
		return s0;
	} else {
		null;
	}
};

OnvifSoap.prototype._request = async function(oxaddr, soap, method_name, information = {}) {
	const isSecure = oxaddr.protocol.includes('https');

	if (information['Manufacturer'] === 'PAVANA') {
		if ((['GetProfiles', 'GetStreamUri'].includes(method_name))) {
			oxaddr.pathname = oxaddr.pathname.replace('device', 'media');
		}

		if ((['ContinuousMove', 'Stop'].includes(method_name))) {
			oxaddr.pathname = oxaddr.pathname.replace('device', 'ptz');
		}
	}

	// console.log({ method_name, information, pathname: oxaddr.pathname, soap });

	let promise = new Promise((resolve, reject) => {
		let opts = {
			protocol: oxaddr.protocol,
			// auth    : oxaddr.auth,
			hostname: oxaddr.hostname,
			port    : oxaddr.port,
			path    : oxaddr.pathname,
			method  : 'POST',
			headers: {
				'Content-Type': `application/soap+xml;charset=utf-8`,
				'Content-Length': Buffer.byteLength(soap)
			},
		};

		if (isSecure) {
			opts.agent = new https.Agent({ rejectUnauthorized: false });
		}

		const httpLib = isSecure ? mHttps : mHttp;
		let req = httpLib.request(opts, (res) => {

			res.setEncoding('utf8');
			let xml = '';
			res.on('data', (chunk) => {
				xml += chunk;
			});
			res.on('end', () => {
				if(req) {
					req.removeAllListeners('error');
					req.removeAllListeners('timeout');
					req = null;
				}
				if(res) {
					res.removeAllListeners('data');
					res.removeAllListeners('end');
				}

				// console.log({ statusCode: res.statusCode, soap, xml });

				if(res.statusCode === 200) {
					resolve(xml);
				} else {
					let err = new Error(res.statusCode + ' ' + res.statusMessage);
					let code = res.statusCode;
					let text = res.statusMessage;

					if(xml) {
						this.parse(xml).then((parsed) => {
							let msg = '';
							try {
								msg = parsed['Body']['Fault']['Reason']['Text'];
								if(typeof(msg) === 'object') {
									msg = msg['_'];
								}
							} catch(e) {}
							if(msg) {
								reject(new Error(code + ' ' + text + ' - ' + msg));
							} else {
								reject(err);
							}
						}).catch((error) => {
							reject(err);
						});
					} else {
						reject(err);
					}
				}
				res = null;
			});
		});
	
		req.setTimeout(this.HTTP_TIMEOUT);
	
		req.on('timeout', () => {
			req.abort();
		});
	
		req.on('error', (error) => {
			req.removeAllListeners('error');
			req.removeAllListeners('timeout');
			req = null;
			reject(new Error('Network Error: ' + (error ? error.message : '')));
		});
	
		req.write(soap, 'utf8');
		req.end();
	});
	return promise;
};

OnvifSoap.prototype._getFaultReason = function(r) {
	let reason = '';
	try {
		let reason_el = r['Body']['Fault']['Reason'];
		if(reason_el['Text']) {
			reason = reason_el['Text'];
		} else {
			let code_el = r['Body']['Fault']['Code'];
			if(code_el['Value']) {
				reason = code_el['Value'];
				let subcode_el = code_el['Subcode'];
				if(subcode_el['Value']) {
					reason += ' ' + subcode_el['Value'];
				}
			}
		}
	} catch(e) {}
	return reason;
};

/* ------------------------------------------------------------------
* Method: createRequestSoap(params)
* - params:
*   - body: description in the <s:Body>
*   - xmlns: a list of xmlns attributes used in the body
*       e.g., xmlns:tds="http://www.onvif.org/ver10/device/wsdl"
*   - diff: Time difference [ms]
*   - user: user name
*   - pass: password
* ---------------------------------------------------------------- */
OnvifSoap.prototype.createRequestSoap = function(params) {
	// if (params['body'].includes('GetProfiles')) {
	// 	return this._getProfilesSoap(params);
	// }

	if (params['body'].includes('GetSystemDateAndTime')) {
		return `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><GetSystemDateAndTime xmlns="http://www.onvif.org/ver10/device/wsdl"/></s:Body></s:Envelope>`;
	}

	let soap = '';
	soap += '<?xml version="1.0" encoding="UTF-8"?>';
	soap += '<s:Envelope';
	soap += '  xmlns:s="http://www.w3.org/2003/05/soap-envelope"';
	if(params['xmlns'] && Array.isArray(params['xmlns'])) {
		params['xmlns'].forEach((ns) => {
			soap += ' ' + ns;
		});
	}
	soap += '>';
	soap += '<s:Header>';

	if(params['user']) {
		soap += this._createSoapUserToken(params['diff'], params['user'], params['pass']);
	}

	soap += '</s:Header>';
	soap += '<s:Body>' + params['body'] + '</s:Body>';
	soap += '</s:Envelope>';

	soap = soap.replace(/\>\s+\</g, '><');
	return soap;
};

// OnvifSoap.prototype._getProfilesSoap = function(params) {
// 	const { digest, nonce, created } = this._createDigest(params.diff, params.user, params.pass);
//
// 	return `
// 	<?xml version="1.0" encoding="UTF-8"?>
// <s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
//             xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
//             xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
//    <s:Header>
//       <wsse:Security>
//          <wsse:UsernameToken>
//             <wsse:Username>${params.user}</wsse:Username>
//             <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password>
//             <wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce}</wsse:Nonce>
//             <wsu:Created>${created}</wsu:Created>
//          </wsse:UsernameToken>
//       </wsse:Security>
//    </s:Header>
//    <s:Body>
//       <GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>
//    </s:Body>
// </s:Envelope>
// `
// }

OnvifSoap.prototype._createNonce = function(digit) {
	let nonce = Buffer.alloc(digit);
	mCrypto.randomBytes(digit).copy(nonce);
	return nonce;
};

OnvifSoap.prototype._createDigest = function (diff, user, pass) {
	if (!diff) diff = 0;
	if (!pass) pass = '';

	// let created = (new Date(Date.now() + diff)).toISOString();
	// let nonce_base64 = Buffer.allocUnsafe(16);
	// nonce_base64.writeUIntLE(Math.ceil(Math.random() * 0x100000000), 0, 4);
	// nonce_base64.writeUIntLE(Math.ceil(Math.random() * 0x100000000), 4, 4);
	// nonce_base64.writeUIntLE(Math.ceil(Math.random() * 0x100000000), 8, 4);
	// nonce_base64.writeUIntLE(Math.ceil(Math.random() * 0x100000000), 12, 4);
	//
	// let cryptoDigest = mCrypto.createHash('sha1');
	// cryptoDigest.update(Buffer.concat([nonce_base64, Buffer.from(date, 'ascii'), Buffer.from(pass, 'ascii')]));
	// let digest = cryptoDigest.digest('base64');
	//
	// nonce_base64 = nonce_base64.toString('base64');

	const nonce = mCrypto.randomBytes(16).toString('base64');
	const created = (new Date(Date.now() + diff)).toISOString();
	const digest = mCrypto
		.createHash('sha1')
		.update(Buffer.concat([Buffer.from(nonce, 'base64'), Buffer.from(created), Buffer.from(pass)]))
		.digest('base64');

	return {
		digest,
		created,
		nonce,
	}
}

OnvifSoap.prototype._createSoapUserToken = function(diff, user, pass) {
	const { digest, nonce, created } = this._createDigest(diff, user, pass);

	let soap = '';

	soap += '<Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">';
	soap += '  <UsernameToken>';
	soap += '    <Username>' + user + '</Username>';
	soap += '    <Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">' + digest + '</Password>';
	soap += '    <Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">' + nonce + '</Nonce>';
	soap += '    <Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">' + created + '</Created>';
	soap += '  </UsernameToken>';
	soap += '</Security>';

	return soap;
};

/* ------------------------------------------------------------------
* Method: isInvalidValue(value, type, allow_empty)
* - type: 'undefined', 'null', 'array', 'integer', 'float', 'boolean', 'object'
* ---------------------------------------------------------------- */
OnvifSoap.prototype.isInvalidValue = function(value, type, allow_empty) {
	let vt = this._getTypeOfValue(value);
	if(type === 'float') {
		if(!vt.match(/^(float|integer)$/)) {
			return 'The type of the value must be "' + type + '".';
		}
	} else {
		if(vt !== type) {
			return 'The type of the value must be "' + type + '".';
		}
	}

	if(!allow_empty) {
		if(vt === 'array' && value.length === 0) {
			return 'The value must not be an empty array.';
		} else if(vt === 'string' && value === '') {
			return 'The value must not be an empty string.';
		}
	}
	if(typeof(value) === 'string') {
		if(value.match(/[^\x20-\x7e]/)) {
			return 'The value must consist of ascii characters.';
		}
		if(value.match(/[\<\>]/)) {
			return 'Invalid characters were found in the value ("<", ">")';
		}
	}
	return '';
};

OnvifSoap.prototype._getTypeOfValue = function(value) {
	if(value === undefined) {
		return 'undefined';
	} else if(value === null) {
		return 'null';
	} else if(Array.isArray(value)) {
		return 'array';
	}
	let t = typeof(value);
	if(t === 'boolean') {
		return 'boolean';
	} else if(t === 'string') {
		return 'string';
	} else if(t === 'number') {
		if(value % 1 === 0) {
			return 'integer';
		} else {
			return 'float';
		}
	} else if(t === 'object') {
		if(Object.prototype.toString.call(value) === '[object Object]') {
			return 'object';
		} else {
			return 'unknown';
		}
	} else {
		return 'unknown';
	}
}

module.exports = new OnvifSoap();