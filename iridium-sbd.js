// Node.js library for Iridium SBD (short burst data)
// v0.0.1 (2012-12-28)
// (C) 2015 Brian Robinson <brian@ndmweb.com>
// (C) 2016 Scott Penrose <scottp@dd.com.au>
// (C) 2016 Kurtis Harms <emailkurtis@gmail.com>

// Original Source: http://www.veri.fi/iridiumsbd.tar.gz
// (C) 2012 Razvan Dragomirescu <razvan.dragomirescu@veri.fi>

const zlib = require('zlib'),
    async = require('async'),
    SerialPort = require("serialport"),
    EventEmitter = require('events');

let iridiumEvents = new EventEmitter();

let df, er, tf;

let serialPort;
let serialEmitter;

const OK = /^OK\r/;
const ALL = /.*/;

const bufferSize = 1024;

// this array contains all possible unsollicited response codes and their
// corresponding handling functions

let iridium = {
    buffer: "",
    data: "",
    messagePending: 0,
    binary: {mode: false, buffer: Buffer.alloc(bufferSize), bufferCounter: 0},
    errors: [
        /ERROR/
    ],
    lock: 0,
    pending: 0,
    globals: {
        bars: 0,
        baudrate: 19200, //serial baudrate for the RockBlock
        debug: 0, //should send extra debug info to the console
        defaultTimeout: 40 * 1000, // 60 seconds general timeout for all commands
        simpleTimeout: 2000, // 2 seconds timeout for simple command such as "echo off" (ATE0)
        timeoutForever: -1,
        maxAttempts: 5, //max attempts to send a message
        port: "/dev/ttyUSB0",
        flowControl: false
    },
    // emit a 'ringalert' event if the SBDRING unsollicited response is received
    sbdring: function () {
        iridiumEvents.emit('ringalert');
    },

    // log if debug enabled
    log: function (message) {
        if (iridium.globals.debug) {
            iridiumEvents.emit('debug', message);
        }
    },
    on: function (ev, callback) {
        iridiumEvents.on(ev, callback);
    },
    // interpret the automatic registration result
    areg: function (line) {
        var m = line.match(/^\+AREG:(\d+),(\d+)/);
        var regevent = m[1];
        var regerr = m[2];
        iridium.log("Registration result: " + regevent + " with error " + regerr);
    },

    unsollicited: {
        "SBDRING": {
            pattern: /^SBDRING/,
            execute: 'sbdring'
        },
        "AREG": {
            pattern: /^\+AREG/,
            execute: 'areg'
        }
    },

    // this is the modem initialization process - echo off, clear all buffers (MO & MT)
    // query registration status (should return 2 = registered)
    // enable ring alert (AT+SBDMTA=1)
    init: function () {
        iridium.batchProcess([
            iridium.echoOff,
            iridium.clearBuffers,
            iridium.enableRegistration,
            iridium.ringAlertEnable,
            iridium.initComplete
        ]);
    },

    batchProcess: function (tasks) {
        async.series(tasks, function (err, results) {
            if (err) {
                iridium.log("Batch process had error: ", err, results);
            } else {
                iridium.log("Batch process completed OK", err, results);
            }
        });
    },

    initComplete: function (callback) {
        iridiumEvents.emit('initialized');
        iridium.log("[SBD] IRIDIUM INITIALIZED");
        callback(null);
    },

    sendCompressedMessage: function (text, callback) {
        zlib.deflateRaw(Buffer.alloc(text, 'utf-8'), function (err, buffer) {
            if (!err) {
                iridium.log("Text compressed, initial length " + text.length + ", compressed length " + buffer.length);

                iridium.c_attempt = 0;
                iridium.mailboxSend(buffer, callback);
            }
        });
    },

    mailboxCheck: function () {
        if (iridium.lock) {
            iridium.pending++;
        } else {
            iridium.sendMessage("");
        }
    },

    mailboxSend: function (buffer, callback) {
        iridium.c_attempt++;
        if (iridium.c_attempt <= iridium.globals.maxAttempts) {
            iridium.lock = 1;
            iridium.sendBinaryMessage(buffer, function (err, momsn) {
                if (err == null) {
                    if (buffer) iridium.log("[SBD] Binary message sent successfully, assigned MOMSN " + momsn);

                    // check to see if there are other messages pending - if there are, send a new mailbox check to fetch them in 1 second
                    if (iridium.pending > 0) setTimeout(function () {
                        iridium.sendMessage("");
                    }, 1000);
                    else {
                        iridium.lock = 0;
                    }
                    callback(false, momsn);

                } else {
                    iridium.log("[SBD] Iridium returned error " + err + ", will retry in 20s");
                    setTimeout(function () {
                        iridium.mailboxSend(buffer, callback);
                    }, 20000);
                }
            });
        } else {
            iridium.log('[SBD] Failed to send. The maxAttempts of send requests has been reached.');
            callback({error: 'Failed to send. The maxAttempts of send requests has been reached.'});
        }
    },

    sendBinaryMessage: function (message, callback, maxWait) {
        if (message.length == 0) {
            iridium.sendMessage(message, callback, maxWait);
            return;
        }

        let buffer = (message instanceof Buffer) ? message : Buffer.alloc(message);

        const command = "AT+SBDWB=" + buffer.length;

        let ob = Buffer.alloc(buffer.length + 2);
        let sum = 0;
        for (var i = 0; i < buffer.length; i++) {
            ob[i] = buffer[i];
            sum += buffer[i];
        }
        ob[buffer.length + 1] = sum & 0xff;
        sum >>= 8;
        ob[buffer.length] = sum & 0xff;

        // first write the binary message to storage - issue AT+SBDWB and wait for the modem to say READY
        iridium.AT(command, /READY/, ALL, function (err, text) {

            if (err) {
                iridium.messagePending = 0;
                iridium.clearMOBuffers(function () {
                    callback(err);
                });
                return;
            }

            // send the binary message and wait for OK
            iridium.ATS(ob, OK, ALL, function (berr) {
                if (berr) {
                    iridium.messagePending = 0;
                    iridium.clearMOBuffers(function () {
                        callback(berr);
                    });
                    return;
                }

                iridium.messagePending = 1;
                iridium.waitForNetwork(function (xerr) {
                    if (xerr) {
                        iridium.messagePending = 0;
                        iridium.clearMOBuffers(function () {
                            callback(xerr);
                        });
                        return;
                    }

                    iridium.messagePending = 2;
                    iridium.disableSignalMonitoring(function (xcallback) {
                        iridium.initiateSession(callback);
                    });
                }, iridium.globals.maxWait);
            });
        });
    },

    // send a message via SBD and callback when done
    sendMessage: function (message, callback, maxWait) {
        // if no message is given, this is a mailbox check, so clear the MO storage
        const command = message ? "AT+SBDWT=" + message : "AT+SBDD0";
        // write the MO message, wait for network (+CIEV event)
        // disable signal monitoring (+CIER=0) then send the message (+SBDIXA)
        iridium.AT(command, OK, ALL, function (err, text) {
            if (err) {
                iridium.messagePending = 0;
                iridium.clearMOBuffers(function () {
                    callback(err);
                });
                return;
            }

            iridium.messagePending = 1;
            iridium.waitForNetwork(function (xerr) {
                if (xerr) {
                    iridium.messagePending = 0;
                    iridium.clearMOBuffers(function () {
                        callback(xerr);
                    });
                    return;
                }
                iridium.messagePending = 2;
                iridium.disableSignalMonitoring(function (xcallback) {
                    iridium.initiateSession(callback);
                });
            }, maxWait);
        });
    },
    // in binary mode we do not stop at OK or any other regexp, it's all time-based (it reads all available data for bufferTimeout seconds)
    enableBinaryMode: function (bufferTimeout) {
        iridium.binary.mode = true;
        setTimeout(function () {
            let ob = Buffer.alloc(iridium.binary.bufferCounter);
            iridium.binary.buffer.copy(ob, 0, 0, ob.length);
            serialEmitter.emit('data', ob);
            iridium.binary.bufferCounter = 0;
            iridium.binary.mode = false;
        }, bufferTimeout);
    },
    // read line by line or a whole binary blob, depending on the mode
    readSBD: function (emitter, buffer) {
        serialEmitter = emitter;

        if (iridium.binary.mode) {
            buffer.copy(iridium.binary.buffer, iridium.binary.bufferCounter);
            iridium.binary.bufferCounter += buffer.length;
        }
        else {
            // Collect data
            iridium.data += buffer.toString('binary');
            // Split collected data by delimiter
            let parts = iridium.data.split("\n");
            iridium.data = parts.pop();
            parts.forEach(function (part, i, array) {
                emitter.emit('data', part);
            });
        }
    },
    // open the serial port
    // config options are: "debug" (set to 1 to monitor the AT commands and response
    // and "port" (the actual device to use - defaults to /dev/ttyUSB0)
    open: function (config) {
        if (config) {
            //change globals...
            for (let key in config) {
                if (typeof iridium.globals[key] != 'undefined') {
                    iridium.globals[key] = config[key];
                }
                iridium.log('set option: ' + key + ": " + config[key]);
            }
            /*
             if (config.debug) debug=config.debug;
             if (config.port) port=config.port;
             iridium.globals.flowControl=!!config.flowControl;
             */
        }
        serialPort = new SerialPort(iridium.globals.port, {
            baudrate: iridium.globals.baudrate,
            buffersize: bufferSize,
            parser: iridium.readSBD
        });
        serialPort.on("data", function (data) {
            iridium.log("< " + data);
            if (!er) {
                df(null, data);
                delete(df);
                delete(er);
                return;
            }

            for (x in iridium.unsollicited) {
                if (iridium.unsollicited[x].pattern.test(data)) {
                    iridium[iridium.unsollicited[x].execute](data);
                    return;
                }
            }

            for (x in iridium.errors) {
                if (iridium.errors[x].test(data)) {
                    df(iridium.errors[x], iridium.buffer);
                    iridium.buffer = "";
                    delete(df);
                    delete(er);
                    return;
                }
            }

            if (!kr || kr.test(data)) {
                iridium.buffer += (data + "\n");
            }
            if (er && er.test(data)) {
                df(null, iridium.buffer);
                iridium.buffer = "";
                delete(df);
                delete(er);
            }
        });
        serialPort.on("error", function (error) {
            iridium.log("ERROR: " + error);
        });

        serialPort.on("open", function () {
            if (iridium.globals.flowControl) {
                iridium.init();
            } else {
                //iridium.disableFlowControl(iridium.init);
                iridium.init();
            }
        });
    },

    close: function (callback) {
        serialPort.close(callback);
    },

    waitForNetwork: function (callback, maxWait) {
        iridium.ATS("AT+CIER=1,1,0", /\+CIEV:0,[^0]/, ALL, callback, iridium.globals.maxWait ? iridium.globals.maxWait : iridium.globals.timeoutForever);
    },

    getSystemTime: function (callback) {
        iridium.AT("AT+CCLK?", OK, ALL, function (err, result) {
            if (err) callback(err);
            else {
                var m = result.match(/CCLK:(\d+)\/(\d+)\/(\d+),(\d+):(\d+):(\d+)/);
                if (!m) callback("UNKNOWN_TIME");
                else {
                    var ctime = new Date(Date.UTC(2000 + Number(m[1]), m[2] - 1, m[3], m[4], m[5], m[6]));
                    callback(null, ctime);
                }
            }
        });
    },

    getNetworkTime: function (callback) {
        iridium.AT("AT-MSSTM", OK, ALL, function (err, result) {
            if (err) callback(err);
            else {
                let m = result.match(/-MSSTM:\s*(.*)/);
                if (!m) callback("UNKNOWN_TIME");
                else {
                    // http://www.marsat.ru/files/files%20to%20upload/iridium%20system%20time%20change.pdf
                    // New Epoch for Iridium = May 11, 2014, at 14:23:55 = 1399818235
                    let ctime = new Date(1399818235000 + (parseInt(m[1], 16) * 90));
                    // epoch vs date object callback(null, 1399818235+(parseInt(m[1], 16)*90/1000));
                    callback(null, ctime);
                }
            }
        });
    },

    disableFlowControl: function (callback) {
        iridium.log("[SDB] DISABLING FLOW CONTROL");
        iridium.ATS("AT&K0", OK, ALL, callback, iridium.globals.simpleTimeout);
    },

    disableSignalMonitoring: function (callback) {
        iridium.ATS("AT+CIER=0,0,0", OK, ALL, callback, iridium.globals.simpleTimeout);
    },
    getSignalQuality: function (callback) {
        iridium.AT("AT+CSQ", OK, ALL, function (err, result) {
            if (err) callback(err);
            else {
                var m = result.match(/CSQ:\s*(.*)/);
                if (!m) callback("UNKNOWN_SIGNAL_QUALITY");
                else {
                    callback(null, parseInt(m[1]));
                }
            }
        });
    },
    ringAlertEnable: function (callback) {
        iridium.ATS("AT+SBDMTA=1", OK, ALL, callback, iridium.globals.simpleTimeout);
    },

    echoOff: function (callback) {
        iridium.ATS("ATE0", OK, ALL, callback, iridium.globals.simpleTimeout);
    },

    enableRegistration: function (callback) {
        iridium.ATS("AT+SBDAREG=1", OK, ALL, callback, iridium.globals.simpleTimeout);
    },

    clearMOBuffers: function (callback) {
        iridium.ATS("AT+SBDD0", OK, ALL, callback, iridium.globals.simpleTimeout);
    },

    clearMTBuffers: function (callback) {
        iridium.ATS("AT+SBDD1", OK, ALL, callback, iridium.globals.simpleTimeout);
    },

    clearBuffers: function (callback) {
        iridium.ATS("AT+SBDD2", OK, ALL, callback, iridium.globals.simpleTimeout);
    },

    // emit a 'newmessage' event containing the message
    // and the number of queued messages still waiting at the server
    readBinaryMessage: function (mtqueued, callback) {
        iridium.enableBinaryMode(1000);
        iridium.AT("AT+SBDRB", false, false, function (err, buffer) {

            if (err) {
                iridium.clearMTBuffers(function () {
                    callback(err);
                });
                return;
            }

            let ib = buffer;
            let messageLength = ib.readUInt16BE(0);
            let messageBuffer = Buffer.alloc(messageLength);
            ib.copy(messageBuffer, 0, 2, messageLength + 2);

            iridium.log("Received message is " + messageBuffer.toString('hex'));
            iridium.binary.mode = false;
            iridium.pending = mtqueued;
            iridiumEvents.emit('newmessage', messageBuffer, mtqueued);
            iridium.clearMTBuffers(callback);
        }, iridium.globals.simpleTimeout);
    },

    // emit a 'newmessage' event containing the message
    // and the number of queued messages still waiting at the server
    readMessage: function (mtqueued, callback) {
        iridium.AT("AT+SBDRT", OK, ALL, function (err, text) {
            if (err) {
                iridium.clearMTBuffers(function () {
                    callback(err);
                });
                return;
            }

            let m = text.match(/SBDRT:[^]{2}(.*)/);
            let rmessage = m[1];
            iridium.log("Received message is " + rmessage);
            iridiumEvents.emit('newmessage', rmessage, mtqueued);
            iridium.clearMTBuffers(callback);
        }, iridium.globals.simpleTimeout);
    },

    // most important function, initiates a SBD session and sends/receives messages
    initiateSession: function (callback) {
        iridium.AT("AT+SBDIXA", OK, /\+SBDIX/, function (err, text) {

            if (err) {
                iridium.messagePending = 1;
                iridium.clearMOBuffers(function () {
                    callback(err);
                });
                return;
            }
            let m = text.match(/\+SBDIX: (\d+), (\d+), (\d+), (\d+), (\d+), (\d+)/);

            if (m && m.length) {
                const status = m[1];
                const momsn = m[2];
                const mtstatus = m[3];
                const mtmsn = m[4];
                const mtlen = m[5];
                const mtqueued = m[6];

                if (status <= 4) {
                    iridium.log("MO message transferred successfully");
                    iridium.messagePending = 0;
                } else if (status == 18) {
                    iridium.log("MO message failed, radio failure");
                    iridium.messagePending = 1;
                    iridium.clearMOBuffers(function () {
                        callback("radio failure");
                    });
                    return;
                } else if (status == 32) {
                    iridium.log("MO message failed, network failure");
                    iridium.messagePending = 1;
                    iridium.clearMOBuffers(function () {
                        callback("network failure");
                    });
                    return;
                } else {
                    iridium.log("MO message failed, error " + status);
                    iridium.messagePending = 1;
                    iridium.clearMOBuffers(function () {
                        callback("unknown failure");
                    });
                    return;
                }

                if (mtqueued > 0) {
                    iridium.log("There are still " + mtqueued + " messages waiting!");
                }

                if (mtstatus == 0) {
                    iridium.log("No MT messages are pending");
                    iridium.finishSession(callback, momsn);
                } else if (mtstatus == 1) {
                    iridium.log("A MT message has been transferred, use AT+SBDRT to read it");
                    //disableFlowControl(function(){
                    iridium.readBinaryMessage(mtqueued, function () {
                        iridium.clearMOBuffers(function (err) {
                            callback(err, momsn);
                        });
                    });
                } else {
                    iridium.log("Error determining MT status: " + mtstatus);
                    iridium.finishSession(callback, momsn);
                }
            } else {
                iridium.log("Error parsing SBDIX!");
                iridium.finishSession(callback, momsn);
            }
        });
    },
    finishSession: function (callback, momsn) {
        iridium.clearMOBuffers(function (err) {
            callback(err, momsn);
        });
    },
    // simplified AT command function - when you don't care about the result
    // the end callback is simply a null function (does nothing)
    ATS: function (command, endregexp, keepregexp, callback, timeout) {
        iridium.AT(command, endregexp, keepregexp, callback, timeout);
    },
    // send an AT command to the modem and call datafunction when complete
    // endregexp is the regular expression that marks the end of the response (usually the string OK)
    // keepregexp tells it to filter the response and keep only the lines that match it
    // datafunction is the function to call when the response is fully received
    AT: function (command, endregexp, keepregexp, datafunction, timeout) {
        er = endregexp; // when to push the completed buffer to the datafunction
        kr = keepregexp; // what lines to keep
        if (tf) clearTimeout(tf); // any new AT command clears the previous command
        delete tf;
        df = function (err, text) {
            if (tf) clearTimeout(tf);
            delete(tf);
            datafunction(err, text); // what to call when ended
        };
        if (!timeout) timeout = iridium.globals.defaultTimeout; // general timeout 60 seconds
        if (timeout > 0) tf = setTimeout(function () {
            iridium.log("Sending a timeout event for command " + command);
        }, timeout);

        if (command instanceof Buffer) {
            iridium.log("[BINARY] > " + command.toString('hex'));
            serialPort.write(command);
        } else {
            iridium.log("> " + command);
            serialPort.write(command + "\r");
        }
    }

};

module.exports = iridium;
