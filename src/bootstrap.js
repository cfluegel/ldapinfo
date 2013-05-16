// Opera.Wang+ldapInfo@gmail.com GPL/MPL
"use strict";

const { classes: Cc, Constructor: CC, interfaces: Ci, utils: Cu, results: Cr, manager: Cm } = Components;
Cu.import("resource://gre/modules/Services.jsm");
// if use custom resouce, refer here
// http://mdn.beonex.com/en/JavaScript_code_modules/Using.html

function loadIntoWindow(window) {
  if ( !window ) return;
  let document = window.document;
  let type = document.documentElement.getAttribute('windowtype');
  let target = [ "mail:3pane", "msgcompose", "mail:addressbook" ];
  if ( target.indexOf(type) < 0 ) return;
  ldapInfoLog.log("load");
  ldapInfo.Init(window);
}
 
function unloadFromWindow(window) {
  if ( !window ) return;
  ldapInfoLog.log("unload");
  ldapInfo.unLoad(window);
  // Remove any persistent UI elements
  // Perform any other cleanup
}
 
var windowListener = {
  onOpenWindow: function(aWindow) {
    let onLoadWindow = function() {
      aWindow.removeEventListener("load", onLoadWindow, false);
      loadIntoWindow(aWindow);
    };
    let onUnloadWindow = function() {
      aWindow.removeEventListener("unload", onUnloadWindow, false);
      unloadFromWindow(aWindow);
    };
    aWindow.addEventListener("load", onLoadWindow, false);
    aWindow.addEventListener("unload", onUnloadWindow, false);
  },
  windowWatcher: function(subject, topic) {
    if (topic == "domwindowopened") {
      windowListener.onOpenWindow(subject);
    }
  },
};

function startup(aData, aReason) {
  Cu.import("chrome://ldapInfo/content/log.jsm");
  Cu.import("chrome://ldapInfo/content/ldapInfo.jsm");
  // Load into any existing windows
  let windows = Services.wm.getEnumerator("mail:3pane");
  while (windows.hasMoreElements()) {
    let domWindow = windows.getNext().QueryInterface(Ci.nsIDOMWindow);
    ldapInfoLog.log(domWindow);
    ldapInfoLog.log(domWindow.document);
    ldapInfoLog.log(domWindow.document.readyState);
    if ( domWindow.document.readyState == "complete" ) {
      loadIntoWindow(domWindow);
    } else {
      windowListener.onOpenWindow(domWindow);
    }
  }
  // Wait for new windows
  Services.ww.registerNotification(windowListener.windowWatcher);
}
 
function shutdown(aData, aReason) {
  // When the application is shutting down we normally don't have to clean
  // up any UI changes made
  //if (aReason == APP_SHUTDOWN) return;
  Services.ww.unregisterNotification(windowListener.windowWatcher)
 
  // Unload from any existing windows
  let windows = Services.wm.getEnumerator("mail:3pane");
  while (windows.hasMoreElements()) {
    let domWindow = windows.getNext().QueryInterface(Ci.nsIDOMWindow);
    Services.console.logStringMessage('unload from window');
    unloadFromWindow(domWindow);
    Services.console.logStringMessage('unload from window 2');
    //domWindow.removeEventListener("unload", onUnloadWindow, false);
    Services.console.logStringMessage('force GC CC');
    // Do CC & GC, comment out allTraces when release
    domWindow.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDOMWindowUtils).garbageCollect(
      // Cc["@mozilla.org/cycle-collector-logger;1"].createInstance(Ci.nsICycleCollectorListener).allTraces()
    );
    Services.console.logStringMessage('force GC CC done');
  }
  ldapInfo.cleanup();
  Cu.unload("chrome://ldapInfo/content/ldapInfo.jsm");
  //Cu.unload("chrome://ldapInfo/content/sprintf.jsm");
  //Cu.unload("chrome://ldapInfo/content/aop.jsm");
  //Cu.unload("chrome://ldapInfo/content/ldapInfoFetch.jsm");
  Services.console.logStringMessage('shutdown almost done');
  Cu.unload("chrome://ldapInfo/content/log.jsm");
  ldapInfo = ldapInfoLog = null;
  // flushStartupCache
  // Init this, so it will get the notification.
  //Cc["@mozilla.org/xul/xul-prototype-cache;1"].getService(Ci.nsISupports);
  Services.obs.notifyObservers(null, "startupcache-invalidate", null);
  Cu.forceGC();
  Services.console.logStringMessage('shutdown done');
}

function install(aData, aReason) {}
function uninstall(aData, aReason) {}
