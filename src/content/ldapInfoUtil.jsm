// MPL/GPL
// Opera.Wang 2013/06/04
"use strict";
var EXPORTED_SYMBOLS = ["ldapInfoUtil"];

const { classes: Cc, Constructor: CC, interfaces: Ci, utils: Cu, results: Cr, manager: Cm } = Components;
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource:///modules/mailServices.js");
Cu.import("resource://gre/modules/FileUtils.jsm");
const mozIJSSubScriptLoader = Cc["@mozilla.org/moz/jssubscript-loader;1"].getService(Ci.mozIJSSubScriptLoader);

var ldapInfoUtil = {
  loadInTopWindow: function(win, url) {
    win.openDialog("chrome://messenger/content/", "_blank", "chrome,dialog=no,all", null,
      { tabType: "contentTab", tabParams: {contentPage: Services.io.newURI(url, null, null) } });
  },
  loadUseProtocol: function(url) {
    Cc["@mozilla.org/uriloader/external-protocol-service;1"].getService(Ci.nsIExternalProtocolService).loadURI(Services.io.newURI(url, null, null), null);
  },
  loadDonate: function(pay) {
    let url = "https://www.paypal.com/cgi-bin/webscr?cmd=_donations&business=893LVBYFXCUP4&lc=US&item_name=Expression%20Search&no_note=0&currency_code=USD&bn=PP%2dDonationsBF%3abtn_donate_LG%2egif%3aNonHostedGuest";
    if ( typeof(pay) != 'undefined' ) {
      if ( pay == 'alipay' ) url = "https://me.alipay.com/operawang";
      if ( pay == 'mozilla' ) url = "https://addons.mozilla.org/en-US/thunderbird/addon/ldapinfoshow/developers?src=api"; // Meet the developer page
    }
    this.loadUseProtocol(url);
  },
  sendEmailWithTB: function(url) {
    MailServices.compose.OpenComposeWindowWithURI(null, Services.io.newURI(url, null, null));
  },
  loadTab: function(type, args) {
    let mail3PaneWindow = Services.wm.getMostRecentWindow("mail:3pane");
    if (mail3PaneWindow) {
      let tabmail = mail3PaneWindow.document.getElementById("tabmail");
      if ( !tabmail ) return;
      mail3PaneWindow.focus();
      tabmail.openTab(type, args);
    }
  },

  folderPicker: function(win, prefid) {
    try {
      let perf = win.document.getElementById(prefid);
      if ( !perf ) return;
      const nsIFilePicker = Ci.nsIFilePicker;
      let fp = Cc["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
      let fpCallback = function fpCallback_done(aResult) {
        if (aResult == nsIFilePicker.returnOK) {
          try {
            if ( fp.file && fp.file.path && fp.file.isDirectory() && fp.file.isReadable() ) {
              perf.value = fp.file.path;
            }
          } catch (err) {
            Services.console.logStringMessage(err);
          }
        }
      };
      fp.init(win, "Folder", nsIFilePicker.modeGetFolder);
      try {
        fp.displayDirectory = new FileUtils.File(perf.value);
      } catch (err) {}
      fp.open(fpCallback);
    } catch (err) {
      Services.console.logStringMessage(err);
    }
  },

  // TODO: When bug 564675 is implemented this will no longer be needed
  // Always set the default prefs, because they disappear on restart
  setDefaultPrefs: function (path) {
    let branch = Services.prefs.getDefaultBranch("");
    let prefLoaderScope = {
      pref: function(key, val) {
        switch (typeof val) {
          case "boolean":
            branch.setBoolPref(key, val);
            break;
          case "number":
            branch.setIntPref(key, val);
            break;
          case "string":
            branch.setCharPref(key, val);
            break;
        }
      }
    };
    let uri = Services.io.newURI("defaults/preferences/prefs.js", null, Services.io.newURI(path, null, null));
    try {
      mozIJSSubScriptLoader.loadSubScript(uri.spec, prefLoaderScope);
    } catch (err) {
      Cu.reportError(err);
    }
  },
  options: {},
  initPerf: function(path) {
    this.setDefaultPrefs(path);
    this.prefs = Services.prefs.getBranch("extensions.ldapinfoshow.");
    this.prefs.addObserver("", this, false);
    try {
      [ "ldap_attributes", "photoURL", "load_from_local_dir", "local_pic_dir", "load_from_addressbook", "load_from_gravatar", "filterTemplate", "click2dial"
      , "load_from_facebook", "facebook_token", "facebook_token_expire", "load_from_google"
      , "load_from_photo_url", "ldapIdleTimeout", "ldapTimeoutWhenCached", "ldapTimeoutInitial", "enable_verbose_info"].forEach( function(key) {
        ldapInfoUtil.observe('', 'nsPref:changed', key); // we fake one
      } );
    } catch (err) { Services.console.logStringMessage(err); }
  },
  observe: function(subject, topic, data) {
    if (topic != "nsPref:changed") return;
      switch(data) {
        case "enable_verbose_info":
          this.options[data] = this.prefs.getBoolPref(data);
          break;
        case "load_from_local_dir":
        case "load_from_addressbook":
        case "load_from_facebook":
        case "load_from_google":
        case "load_from_gravatar":
        case "load_from_photo_url":
          this.options[data] = this.prefs.getBoolPref(data);
          if ( typeof(this._onChangeCallback) == 'function' ) this._onChangeCallback();
          break;
        case "ldap_attributes":
        case "photoURL":
        case "filterTemplate":
        case "local_pic_dir":
          if ( typeof(this._onChangeCallback) == 'function' ) this._onChangeCallback();
          // NO BREAK HERE
        case "click2dial":
        case "facebook_token":
        case "facebook_token_expire":
          this.options[data] = this.prefs.getCharPref(data);
          break;
        default:
          this.options[data] = this.prefs.getIntPref(data);
          break;
     }
  },
  setChangeCallback: function(callback) {
    this._onChangeCallback = callback;
  },
  onSyncFromPreference: function(doc,self) {
    let textbox = self;
    let preference = doc.getElementById('facebook_token_expire');
    let actualValue = preference.value !== undefined ? preference.value : preference.defaultValue;
    let date = new Date((+actualValue)*1000);
    return date.toLocaleFormat("%Y/%m/%d %H:%M:%S");
  },
  resetToken: function(doc) {
    ["pref_facebook_token", "facebook_token_expire"].forEach( function(ID) {
      let element = doc.getElementById(ID);
      if ( element ) element.reset();
    } );
  },
  cleanup: function() {
    this.prefs.removeObserver("", this, false);
    this.prefs = null;
    //this.options = {};
    delete this._onChangeCallback;
  }
}