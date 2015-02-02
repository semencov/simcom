(function() {
  var EventEmitter, Modem, Q, buffertools, init, instances, serialport, util;

  util = require("util");

  serialport = require("serialport");

  buffertools = require("buffertools");

  Q = require("q");

  EventEmitter = require("events").EventEmitter;

  instances = {};

  Modem = (function() {
    var fetchExecution, isResultCode, processLine, processLines, processResponse, processUnboundLine, readBuffer, unboundExprs;

    function Modem(device, options) {
      options = options || {};
      if (!options.lineEnd) {
        options.lineEnd = "\r\n";
      }
      if (!options.baudrate) {
        options.baudrate = 115200;
      }
      this.options = options;
      this.opened = false;
      this.device = device;
      this.port = null;
      this.buffer = new Buffer(0);
      this.lines = [];
      this.executions = [];
      buffertools.extend(this.buffer);
      return;
    }

    util.inherits(Modem, EventEmitter);

    Modem.prototype.open = function(timeout) {
      var self;
      self = this;
      if (self.opened) {
        self.emit("open");
        return;
      }
      timeout = timeout || 5000;
      this.port = new serialport.SerialPort(this.device, {
        baudrate: this.options.baudrate,
        parser: serialport.parsers.raw
      });
      this.port.on("open", function() {
        this.on("data", function(data) {
          self.buffer = Buffer.concat([self.buffer, data]);
          readBuffer.call(self);
        });
        self.execute({
          command: "AT",
          timeout: timeout
        }).then(function() {
          self.emit("open");
        })["catch"](function(error) {
          self.emit("error", error);
        }).done();
      });
      this.port.on("close", function() {
        self.opened = false;
        self.emit("close");
      });
      this.port.on("error", function(err) {
        self.emit("error", err);
      });
      this.opened = true;
    };

    Modem.prototype.close = function() {
      this.port.close();
      this.port = null;
      instances[this.device] = null;
    };

    Modem.prototype.write = function(data, callback) {
      this.port.write(data, callback);
    };

    Modem.prototype.writeAndWait = function(data, callback) {
      var self;
      self = this;
      this.write(data, function() {
        self.port.drain(callback);
      });
    };

    Modem.prototype.execute = function(command) {
      var defer;
      if (typeof command !== "object") {
        command = {
          command: String(command)
        };
      }
      if (!command.command) {
        return;
      }
      defer = Q.defer();
      defer.execution = {
        exec: command.command,
        pdu: command.pdu || null,
        timeout: command.timeout || false
      };
      if (this.executions.push(defer) === 1) {
        fetchExecution.call(this);
      }
      return defer.promise;
    };

    fetchExecution = function() {
      var defer, execution;
      defer = this.executions[0];
      if (!defer) {
        return;
      }
      execution = defer.execution;
      this.write("" + execution.exec + "\r");
      if (execution.timeout) {
        defer.timer = setTimeout(function() {
          defer.reject(new Error("timed out"));
        }, execution.timeout);
      }
    };

    readBuffer = function() {
      var line, lineEndLength, lineEndPosition, newBuffer, self;
      self = this;
      lineEndLength = self.options.lineEnd.length;
      lineEndPosition = buffertools.indexOf(self.buffer, self.options.lineEnd);
      if (lineEndPosition === -1) {
        if (this.buffer.length === 2 && this.buffer.toString() === "> ") {
          processLine.call(this, this.buffer.toString());
        }
        return;
      }
      line = this.buffer.slice(0, lineEndPosition);
      newBuffer = new Buffer(this.buffer.length - lineEndPosition - lineEndLength);
      this.buffer.copy(newBuffer, 0, lineEndPosition + lineEndLength);
      this.buffer = newBuffer;
      processLine.call(this, line.toString("ascii"));
      process.nextTick(readBuffer.bind(this));
    };

    processUnboundLine = function(line) {
      var i, m, u;
      i = 0;
      while (i < unboundExprs.length) {
        u = unboundExprs[i];
        m = line.match(u.expr);
        if (m) {
          u.func && u.func.call(this, m);
          if (!u.unhandle) {
            this.emit("urc", m, u.expr);
            return true;
          }
        }
        i++;
      }
      return false;
    };

    processLine = function(line) {
      if (line.substr(0, 2) === "AT") {
        return;
      }
      if (processUnboundLine.call(this, line)) {
        return;
      }
      if (this.ringing && line === "NO CARRIER") {
        this.ringing = false;
        this.emit("end ring");
        return;
      }
      this.lines.push(line);
      processLines.call(this);
    };

    isResultCode = function(line) {
      return /(^OK|ERROR|BUSY|DATA|NO CARRIER|COMMAND NOT SUPPORT|> $)|(^CONNECT( .+)*$)/i.test(line);
    };

    processLines = function() {
      if (!this.lines.length) {
        return;
      }
      if (!isResultCode(this.lines[this.lines.length - 1])) {
        return;
      }
      if (this.lines[0].trim() === "") {
        this.lines.shift();
      }
      processResponse.call(this);
      this.lines = [];
    };

    processResponse = function() {
      var b, cmd, defer, execution, pduSize, responseCode;
      responseCode = this.lines.pop();
      defer = this.executions[0];
      execution = defer && defer.execution;
      if (responseCode === "> ") {
        if (execution && execution.pdu) {
          pduSize = execution.pdu.length;
          b = new Buffer(pduSize + 1);
          b.write(execution.pdu);
          b.writeUInt8(26, pduSize);
          this.write(b);
          execution.pdu = null;
        }
        return;
      }
      if (responseCode.match(/^CONNECT( .+)*$/i)) {
        if (execution && execution.pdu) {
          this.write(execution.pdu);
          execution.pdu = null;
        }
        return;
      }
      if (defer) {
        cmd = execution.exec.split("\r", 1).shift();
        this.executions.shift();
        if (defer.timer) {
          clearTimeout(defer.timer);
          defer.timer = null;
        }
        if (responseCode === "ERROR" || responseCode === "COMMAND NOT SUPPORT") {
          defer.reject({
            code: responseCode,
            command: cmd
          });
          return;
        }
        defer.resolve({
          code: responseCode,
          command: cmd,
          lines: this.lines
        });
      }
      if (this.executions.length) {
        fetchExecution.call(this);
      }
    };

    unboundExprs = [
      {
        expr: /^OVER-VOLTAGE WARNNING$/i,
        func: function(m) {
          this.emit("over-voltage warnning");
        }
      }, {
        expr: /^RING$/i,
        func: function(m) {
          this.ringing = true;
          this.emit("ring");
        }
      }, {
        expr: /^\+CMTI:(.+)$/i,
        func: function(m) {
          this.emit("new message", m[1]);
        }
      }, {
        expr: /^\+CPIN: (NOT .+)/i,
        unhandled: true,
        func: function(m) {
          this.emit("sim error", m[1]);
        }
      }, {
        expr: /^\+CUSD:(.+)$/i,
        func: function(m) {
          this.emit("ussd", m[1]);
        }
      }
    ];

    return Modem;

  })();

  init = function(device, options) {
    device = device || "/dev/ttyAMA0";
    if (!instances[device]) {
      instances[device] = new Modem(device, options);
    }
    return instances[device];
  };

  module.exports = init;

}).call(this);