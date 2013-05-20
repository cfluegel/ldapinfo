// Opera Wang, 2010/1/15
// GPL V3 / MPL
// debug utils
"use strict";
var EXPORTED_SYMBOLS = ["ldapInfoLog"];

Components.utils.import("resource://gre/modules/Services.jsm");

var ldapInfoLog = {
  popup: function(title, msg) {
    var image = "chrome://messenger/skin/addressbook/icons/contact-generic.png";
    var win = Services.ww.openWindow(null, 'chrome://global/content/alerts/alert.xul', '_blank', 'chrome,titlebar=no,popup=yes', null);
    win.arguments = [image, title, msg, false, ''];
  },

  log: function(msg,popup) {
    Services.console.logStringMessage(msg);
    if ( typeof(popup)!='undefined' ) {
      if ( typeof(popup) == 'number' ) popup = 'Warning!';
      this.popup(popup,msg);
    }
  },
  
  // from errorUtils.js
  objectTreeAsString: function(o, recurse, compress, level) {
    let s = "";
    let pfx = "";
    let tee = "";
    try {
      if (recurse === undefined)
        recurse = 0;
      if (level === undefined)
        level = 0;
      if (compress === undefined)
        compress = true;
      
      for (let junk = 0; junk < level; junk++)
        pfx += (compress) ? "| " : "|  ";
      
      tee = (compress) ? "+ " : "+- ";
      
      if (typeof(o) != "object") {
        s += pfx + tee + " (" + typeof(o) + ") " + o + "\n";
      }
      else {
        for (let i in o) {
          let t = "";
          try {
            t = typeof(o[i]);
          } catch (err) {
            s += pfx + tee + " (exception) " + err + "\n";
          }
          switch (t) {
            case "function":
              let sfunc = String(o[i]).split("\n");
              if (sfunc[2] == "    [native code]")
                sfunc = "[native code]";
              else
                sfunc = sfunc.length + " lines";
              s += pfx + tee + i + " (function) " + sfunc + "\n";
              break;
            case "object":
              s += pfx + tee + i + " (object) " + o[i] + "\n";
              if (!compress)
                s += pfx + "|\n";
              if ((i != "parent") && (recurse))
                s += this.objectTreeAsString(o[i], recurse - 1,
                                             compress, level + 1);
              break;
            case "string":
              if (o[i].length > 200)
                s += pfx + tee + i + " (" + t + ") " + o[i].length + " chars\n";
              else
                s += pfx + tee + i + " (" + t + ") '" + o[i] + "'\n";
              break;
            case "":
              break;
            default:
              s += pfx + tee + i + " (" + t + ") " + o[i] + "\n";
          }
          if (!compress)
            s += pfx + "|\n";
        }
      }
    } catch (ex) {
      s += pfx + tee + " (exception) " + ex + "\n";
    }
    s += pfx + "*\n";
    return s;
  },
  
  logObject: function(obj, name, maxDepth, curDepth) {
    this.log(name + ":\n" + this.objectTreeAsString(obj,maxDepth,true));
  },
  
  logException: function(e) {
    let msg = "Caught Exception";
    if ( e.name && e.message ) {
      msg += " " + e.name + ": " + e.message + "\n";
    } else if ( e.stack ) {
      msg += e.stack;
    } else if ( e.fileName && e.lineNumber ) {
      msg += "@ " + e.fileName + ":" + e.lineNumber + "\n";
    } else {
      msg += " " + e + "\n";
    }
    this.log(msg, "Exception");
  },
  
};