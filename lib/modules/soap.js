/* ------------------------------------------------------------------
* node-onvif - soap.js
*
* Copyright (c) 2016-2018, Futomi Hatano, All rights reserved.
* Released under the MIT license
* Date: 2018-08-13
* ---------------------------------------------------------------- */
'use strict';
const mXml2Js = require('xml2js');
const mHttp   = require('http');
const mHttps   = require('https');
const https   = require('https');
const mCrypto = require('crypto');
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
OnvifSoap.prototype.requestCommand = function(oxaddr, method_name, soap) {
	let promise = new Promise((resolve, reject) => {

		// console.log({ oxaddr, method_name, soap })

		let xml = '';
		this
			._request(oxaddr, soap, method_name)
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

OnvifSoap.prototype._request = function(oxaddr, soap, method_name) {
	const isSecure = oxaddr.protocol.includes('https');

	let promise = new Promise((resolve, reject) => {
		let opts = {
			protocol: oxaddr.protocol,
			// auth    : oxaddr.auth,
			hostname: oxaddr.hostname,
			port    : oxaddr.port,
			path    : oxaddr.pathname,
			agent   : isSecure ? new https.Agent({ rejectUnauthorized: false }) : false,
			method  : 'POST',
			headers: {
				'Content-Type': `application/soap+xml;charset=utf-8;action="http://www.onvif.org/ver10/device/wsdl/${method_name}"`,
				'Content-Length': Buffer.byteLength(soap)
			},
		};

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

				// console.log({ statusCode: res.statusCode, xml });

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

// OnvifSoap.prototype._passwordDigest = function(diff, pass) {
// 	let date = (new Date(Date.now() + diff)).toISOString();
//
// 	let nonce = Buffer.allocUnsafe(16);
// 	nonce.writeUIntLE(Math.ceil(Math.random() * 0x100000000), 0, 4);
// 	nonce.writeUIntLE(Math.ceil(Math.random() * 0x100000000), 4, 4);
// 	nonce.writeUIntLE(Math.ceil(Math.random() * 0x100000000), 8, 4);
// 	nonce.writeUIntLE(Math.ceil(Math.random() * 0x100000000), 12, 4);
// 	let cryptoDigest = mCrypto.createHash('sha1');
// 	cryptoDigest.update(Buffer.concat([nonce, Buffer.from(date, 'ascii'), Buffer.from(pass, 'ascii')]));
// 	let passdigest = cryptoDigest.digest('base64');
//
// 	return {
// 		date,
// 		digest: passdigest,
// 		nonce_base64: nonce.toString('base64'),
// 	};
// };

OnvifSoap.prototype._generatePasswordDigest = function(diff, password) {
	// Step 1: Generate a random nonce (Base64)
	const nonce = mCrypto.randomBytes(16).toString("base64");

	// Step 2: Get the current timestamp in ISO 8601 format
	const created = new Date(Date.now() + diff).toISOString();

	// Step 3: Concatenate Nonce + Created + Password
	const combined = Buffer.concat([
		Buffer.from(nonce, "base64"), // Decode nonce
		Buffer.from(created, "utf8"),
		Buffer.from(password, "utf8")
	]);

	// Step 4: Create SHA1 hash of the combined value
	const sha1Hash = mCrypto.createHash("sha1").update(combined).digest();

	// Step 5: Encode the hash in Base64
	const passwordDigest = sha1Hash.toString("base64");

	return {
		date: created,
		digest: passwordDigest,
		nonce_base64: nonce,
	}
}

OnvifSoap.prototype._createDigestAuthHeader = function (method, url, username, password, realm, nonce, uri) {
	const qop = 'auth';
	const nc = '00000001';  // Nonce count
	const cnonce = mCrypto.randomBytes(8).toString('hex');  // Client nonce
	const hashedPassword = mCrypto.createHash('md5').update(password).digest('hex');

	const ha1 = mCrypto.createHash('md5').update(`${username}:${realm}:${hashedPassword}`).digest('hex');
	const ha2 = mCrypto.createHash('md5').update(`${method}:${uri}`).digest('hex');
	const response = mCrypto.createHash('md5').update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`).digest('hex');

	return `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
}

OnvifSoap.prototype._createSoapUserToken = function(diff, user, pass) {
	// if(!diff) {diff = 0;}
	// if(!pass) {pass = '';}
	// let date = (new Date(Date.now() + diff)).toISOString();
	// let nonce_buffer = this._createNonce(16);
	// let nonce_base64 = nonce_buffer.toString('base64');
	// let shasum = mCrypto.createHash('sha1');
	// shasum.update(Buffer.concat([nonce_buffer, Buffer.from(date), Buffer.from(pass)]));
	// let digest = shasum.digest('base64');
	//
	// let soap = '';
	//
	// soap += '<Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">';
	// soap += '  <UsernameToken>';
	// soap += '    <Username>' + user + '</Username>';
	// soap += '    <Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">' + digest + '</Password>';
	// soap += '    <Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">' + nonce_base64 + '</Nonce>';
	// soap += '    <Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">' + date + '</Created>';
	// soap += '  </UsernameToken>';
	// soap += '</Security>';

	// const { date, digest, nonce_base64 } = this._passwordDigest(diff, pass);
	const { date, digest, nonce_base64 } = this._generatePasswordDigest(diff, pass);

	let soap = '';

	soap += '<Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">' +
		'<UsernameToken>' +
		'<Username>' + user + '</Username>' +
		'<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">' + digest + '</Password>' +
		'<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">' + nonce_base64 + '</Nonce>' +
		'<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">' + date + '</Created>' +
		'</UsernameToken>' +
		'</Security>';
	return soap;
};

OnvifSoap.prototype._createNonce = function(digit) {
	// Use Buffer.alloc to allocate a buffer of 'digit' bytes
	let nonce = Buffer.alloc(digit);

	// Use crypto.randomBytes to generate secure random bytes
	mCrypto.randomBytes(digit).copy(nonce);

	return nonce;
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