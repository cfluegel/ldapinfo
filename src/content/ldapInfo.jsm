// Opera Wang, 2013/5/1
// GPL V3 / MPL
"use strict";
var EXPORTED_SYMBOLS = ["ldapInfo"];
const { classes: Cc, Constructor: CC, interfaces: Ci, utils: Cu, results: Cr, manager: Cm } = Components;
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource:///modules/mailServices.js");
Cu.import("resource://app/modules/gloda/utils.js");
Cu.import("resource://gre/modules/FileUtils.jsm");
//Cu.import("resource://gre/modules/Dict.jsm");
Cu.import("chrome://ldapInfo/content/ldapInfoFetch.jsm");
Cu.import("chrome://ldapInfo/content/ldapInfoFetchOther.jsm");
Cu.import("chrome://ldapInfo/content/ldapInfoUtil.jsm");
Cu.import("chrome://ldapInfo/content/log.jsm");
Cu.import("chrome://ldapInfo/content/aop.jsm");
Cu.import("chrome://ldapInfo/content/sprintf.jsm");

const boxID = 'displayLDAPPhoto';
const tooltipID = 'ldapinfo-tooltip';
const tooltipGridID = "ldapinfo-tooltip-grid";
const tooltipRowsID = "ldapinfo-tooltip-rows";
const popupsetID = 'ldapinfo-popupset';
const addressBookImageID = 'cvPhoto';
const addressBookDialogImageID = 'photo';
const composeWindowInputID = 'addressingWidget';
const msgHeaderViewDeck = 'msgHeaderViewDeck';
const XULNS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const lineLimit = 2048;
const allServices = ['local_dir', 'addressbook', 'ldap', 'facebook', 'google', 'gravatar'];
const servicePriority = {local_dir: 500, addressbook: 200, ldap: 100, facebook: 50, google: 20, gravatar: 10};

let ldapInfo = {
  // local only provide image, ab provide image & info, but info is used only when ldap not avaliable, other remote provide addtional image or Name/url etc.
  // callback update image src and popup, popup is calculate on the fly, image only have original email address and validImage (default 0).
  // image src will be update if old is not valid or newer has higher priority: local > ab > ldap > facebook > google > gravatar, see servicePriority
  // local dir are positive cache only, others are both positive & negative cache
  // if has src, then it must be valid
  // state: 0 => init / need retry for ldap, 1=> working, 2 => finished, 4 => error
  cache: {}, // { foo@bar.com: { local_dir: {src:file://...}, addressbook: {}, ldap: {state: 2, list1: [], list2: [], src:..., validImage:100}, facebook: {state: 2, src:data:..., facebook: [http://...]}, google: {}, gravatar:{} }
  //mailList: [], // [[foo@bar.com, foo@a.com, foo2@b.com], [...]]
  //mailMap: {}, // {foo@bar.com: 0, foo@a.com:0, ...}
  getLDAPFromAB: function() {
    try {
      ldapInfoLog.info('Get LDAP server from addressbook');
      this.ldapServers = {};
      let allAddressBooks = MailServices.ab.directories;
      let found = false;
      while (allAddressBooks.hasMoreElements()) {
        let addressBook = allAddressBooks.getNext().QueryInterface(Ci.nsIAbDirectory);
        if ( addressBook instanceof Ci.nsIAbLDAPDirectory && addressBook.isRemote && addressBook.lDAPURL ) {
          /* addressBook:
             URI (string) 'moz-abldapdirectory://ldap_2.servers.OriginalName'
             uuid (string) 'ldap_2.servers.OriginalName&CurrentName'
             lDAPURL:
             spec (string) 'ldap://directory.company.com/o=company.com??sub?(objectclass=*)'
             prePath (string) 'ldap://directory.company.com' ==> scheme://user:password@host:port
             hostPort (string) 'directory.company.com'
             host (string) 'directory.company.com'
             path (string) '/o=company.com??sub?(objectclass=*)'
             dn (string) 'o=company.com'
             attributes (string) ''
             filter (string) '(objectclass=*)'
             scope (number) 2
          */
          let ldapURL = addressBook.lDAPURL;
          if ( !addressBook.uuid || !ldapURL.prePath || !ldapURL.spec || !ldapURL.dn ) continue;
          found = true;
          this.ldapServers[addressBook.uuid] = { baseDn:ldapURL.dn, spec:ldapURL.spec, prePath:ldapURL.prePath, host:ldapURL.host, scope:ldapURL.scope,
                                                              attributes:ldapURL.attributes, authDn:addressBook.authDn, dirName:addressBook.dirName.toLowerCase() }; // authDn is binddn
        }
      }
      // if ( Object.getOwnPropertyNames( this.ldapServers ).length === 0 ) {
      if ( !found ) ldapInfoLog.log("Can't find any LDAP servers in address book, please setup on first!", 'Error');
    } catch (err) {
      ldapInfoLog.logException(err);
    }
  },
  
  abListener: {
    onItemAdded: function (aParentDir, aItem) { this.checkItem(aItem); },
    onItemPropertyChanged: function (aItem, aProperty, aOldValue, aNewValue) { this.checkItem(aItem); },
    onItemRemoved: function (aParentDir, aItem) { this.checkItem(aItem); },
    checkItem: function(aItem) {
      if ( aItem instanceof Ci.nsIAbCard ) { // instanceof will QueryInterface
        if ( aItem.isMailList ) {
          ldapInfo.clearCache('addressbook'); // easy way
        } else {
          if ( aItem.primaryEmail ) delete ldapInfo.cache[aItem.primaryEmail];
          if ( aItem.secondEmail ) delete ldapInfo.cache[aItem.secondEmail];
        }
      } else if ( aItem instanceof Ci.nsIAbDirectory ) {
        ldapInfo.getLDAPFromAB();
      }
    },
    Added: false,
    add: function() {
      if ( !this.Added ) MailServices.ab.addAddressBookListener(ldapInfo.abListener, Ci.nsIAbListener.all);
      this.Added = true;
    },
    remove: function() { MailServices.ab.removeAddressBookListener(ldapInfo.abListener); this.Added = false; },
  },

  PopupShowing: function(event) {
    try{
      let doc = event.view.document;
      let triggerNode = event.target.triggerNode;
      let targetNode = triggerNode;
      let headerRow = false;
      if ( triggerNode.nodeName == 'mail-emailaddress' ){
        headerRow = true;
        let emailAddress = triggerNode.getAttribute('emailAddress').toLowerCase();
        let targetID = boxID + emailAddress;
        targetNode = doc.getElementById(targetID);
      }
      ldapInfo.updatePopupInfo(targetNode, triggerNode.ownerDocument.defaultView.window, headerRow ? triggerNode : null);
    } catch (err) {
      ldapInfoLog.logException(err);
    }
    return true;
  },

  createPopup: function(aWindow) {
    /*
    <popupset id="ldapinfo-popupset">
      <panel id="ldapinfo-tooltip" noautohide="true" noautofocus="true" position="start_before" ...">
        <grid id="ldapinfo-tooltip-grid">
          <columns id="ldapinfo-tooltip-columns">
            <column/>
            <column/>
          </columns>
          <rows id="ldapinfo-tooltip-rows">
          </rows>
        </grid>
      </panel>
    </popupset>
    </overlay>
    */
    let doc = aWindow.document;
    let popupset = doc.createElementNS(XULNS, "popupset");
    popupset.id = popupsetID;
    let panel = doc.createElementNS(XULNS, "panel");
    panel.id = tooltipID;
    panel.position = 'start_before';
    panel.setAttribute('noautohide', true);
    panel.setAttribute('noautofocus', true);
    panel.setAttribute('titlebar', 'normal');
    panel.setAttribute('label', 'Contact Information');
    panel.setAttribute('close', true);
    let grid = doc.createElementNS(XULNS, "grid");
    grid.id = tooltipGridID;
    let columns = doc.createElementNS(XULNS, "columns");
    let column1 = doc.createElementNS(XULNS, "column");
    let column2 = doc.createElementNS(XULNS, "column");
    column2.classList.add("ldapInfoPopupDetailColumn");
    let rows = doc.createElementNS(XULNS, "rows");
    rows.id = tooltipRowsID;
    columns.insertBefore(column1, null);
    columns.insertBefore(column2, null);
    grid.insertBefore(columns, null);
    grid.insertBefore(rows, null);
    panel.insertBefore(grid, null);
    popupset.insertBefore(panel, null);
    doc.documentElement.insertBefore(popupset, null);
    panel.addEventListener("popupshowing", ldapInfo.PopupShowing, true);
    aWindow._ldapinfoshow.createdElements.push(popupsetID);
  },

  modifyTooltip4HeaderRows: function(doc, load) {
    try  {
      ldapInfoLog.info('modifyTooltip4HeaderRows ' + load);
      // msgHeaderViewDeck expandedHeadersBox ... [mail-multi-emailHeaderField] > longEmailAddresses > emailAddresses > [mail-emailaddress]
      let deck = doc.getElementById(msgHeaderViewDeck); // using deck so compact headers also work
      if ( !deck ) return;
      let nodeLists = deck.getElementsByTagName('mail-multi-emailHeaderField'); // Can't get anonymous elements directly
      for ( let node of nodeLists ) {
        if ( node.ownerDocument instanceof Ci.nsIDOMDocumentXBL ) {
          let XBLDoc = node.ownerDocument;
          let emailAddresses = XBLDoc.getAnonymousElementByAttribute(node, 'anonid', 'emailAddresses');
          for ( let mailNode of emailAddresses.childNodes ) {
            if ( mailNode.nodeType == mailNode.ELEMENT_NODE && mailNode.className != 'emailSeparator' ) { // maybe hidden
              if ( load ) { // load
                if ( !mailNode._ldapinfoshowHFs ) {
                  mailNode.tooltip = tooltipID;
                  mailNode.tooltiptextSave = mailNode.tooltipText;
                  mailNode.removeAttribute("tooltiptext");
                  mailNode._ldapinfoshowHFs = [];
                  mailNode._ldapinfoshowHFs.push( ldapInfoaop.around( {target: mailNode, method: 'setAttribute'}, function(invocation) {
                    if ( invocation.arguments[0] == 'tooltiptext' ) { // block it
                      this.tooltiptextSave = invocation.arguments[1];
                      return true;
                    }
                    return invocation.proceed(); 
                  })[0] );
                  mailNode._ldapinfoshowHFs.push( ldapInfoaop.around( {target: mailNode, method: 'removeAttribute'}, function(invocation) {
                    if ( invocation.arguments[0] == 'tooltiptext' ) { // block it
                      delete this.tooltiptextSave;
                      return true;
                    }
                    return invocation.proceed(); 
                  })[0] );
                }
              } else { // unload
                if ( mailNode._ldapinfoshowHFs ) {
                  mailNode._ldapinfoshowHFs.forEach( function(hooked) {
                    hooked.unweave();
                  } );
                  delete mailNode._ldapinfoshowHFs;
                  mailNode.setAttribute('tooltiptext', mailNode.tooltiptextSave);
                  delete mailNode.tooltiptextSave;
                  delete mailNode.tooltip;
                }
              }
            }
          }
        }
      }
    } catch (err) {
      ldapInfoLog.logException(err);
    }
  },

  getPhotoFromLocalDir: function(mail, callbackData) {
    let localDir = ldapInfoUtil.options['local_pic_dir'];
    if ( localDir != '' ) {
      let suffixes = ['png', 'gif', 'jpg'];
      return suffixes.some( function(suffix) {
        let file = new FileUtils.File(localDir);
        file.appendRelativePath( mail + '.' + suffix );
        if ( file.exists() ) { // use the one under profiles/Photos
          callbackData.cache.local_dir = { state: 2, src: Services.io.newFileURI(file).spec, _Status: ['Local dir \u2714']};
          return true;
        }
      } );
    }
    return false;
  },

  getPhotoFromAB: function(mail, callbackData) {
    let found = false, card = null, currentData = callbackData.cache.addressbook;
    try {
      let allAddressBooks = MailServices.ab.directories;
      while (allAddressBooks.hasMoreElements()) {
        let addressBook = allAddressBooks.getNext().QueryInterface(Ci.nsIAbDirectory);
        if ( addressBook instanceof Ci.nsIAbDirectory && !addressBook.isRemote ) {
          try {
            card = addressBook.cardForEmailAddress(mail); // case-insensitive && sync, only retrun 1st one if multiple match, but it search on all email addresses
          } catch (err) {}
          if ( card ) {
            let PhotoType = card.getProperty('PhotoType', "");
            if ( ['file', 'web'].indexOf(PhotoType) >= 0 ) {
              let PhotoURI = card.getProperty('PhotoURI', ""); // file://... or http://...
              let PhotoName = card.getProperty('PhotoName', ""); // filename under profiles/Photos/...
              if ( PhotoName ) {
                let file = FileUtils.getFile("ProfD", ['Photos', PhotoName]);
                if ( file.exists() ) { // use the one under profiles/Photos
                  found = true;
                  currentData.src = Services.io.newFileURI(file).spec;
                }
              } else if ( PhotoURI ) {
                found = true;
                currentData.src = PhotoURI;
              }
            }
            let pe = card.properties;
            while ( pe.hasMoreElements()) {
              let property = pe.getNext().QueryInterface(Ci.nsIProperty);
              let value = card.getProperty(property, "");
              currentData[property.name] = [property.value];
            }
          }
        }
        if ( found ) break;
      }
    } catch (err) {
      ldapInfoLog.logException(err);
    }
    currentData.state = 2;
    currentData._Status = ['Addressbook ' + ( found ? '\u2714' : '\u2718')];
    return found;
  },

  Load: function(aWindow) {
    try {
      ldapInfoLog.info("Load for " + aWindow.location.href);
      this.abListener.add();
      let doc = aWindow.document;
      let winref = Cu.getWeakReference(aWindow);
      let docref = Cu.getWeakReference(doc);
      if ( typeof(aWindow._ldapinfoshow) != 'undefined' ) ldapInfoLog.info("Already loaded, return");
      aWindow._ldapinfoshow = { createdElements:[], hookedFunctions:[], TCObserver: null };
      if ( typeof(aWindow.MessageDisplayWidget) != 'undefined' ) { // messeage display window
        // https://bugzilla.mozilla.org/show_bug.cgi?id=330458
        // aWindow.document.loadOverlay("chrome://ldapInfo/content/ldapInfo.xul", null); // async load
        let targetObject = aWindow.MessageDisplayWidget;
        if ( typeof(aWindow.StandaloneMessageDisplayWidget) != 'undefined' ) targetObject = aWindow.StandaloneMessageDisplayWidget; // single window message display
        // for already opened msg window, but onLoadStarted may also called on the same message
        if ( typeof(aWindow.gFolderDisplay) != 'undefined' )ldapInfo.showPhoto(targetObject, aWindow.gFolderDisplay);
        ldapInfoLog.info('msg view hook for onLoadStarted');
        aWindow._ldapinfoshow.hookedFunctions.push( ldapInfoaop.after( {target: targetObject, method: 'onLoadStarted'}, function(result) {
          ldapInfo.showPhoto(this);
          return result;
        })[0] );
        // This is for Thunderbird Conversations
        let TCObserver = {
          observe: function(subject, topic, data) {
            if ( topic == "Conversations" && data == 'Displayed') {
              ldapInfo.showPhoto(targetObject, aWindow.gFolderDisplay);
            }
          },
        };
        Services.obs.addObserver(TCObserver, "Conversations", false);
        aWindow._ldapinfoshow.TCObserver = TCObserver;
        if ( typeof(aWindow.gMessageListeners) != 'undefined' ) { // this not work with multi mail view
          ldapInfo.modifyTooltip4HeaderRows(doc, true);
          ldapInfoLog.info('gMessageListeners register for onEndHeaders');
          let listener = {};
          listener.winref = winref;
          listener.onStartHeaders = listener.onEndAttachments = function() {};
          listener.onEndHeaders = function() {
            ldapInfoLog.info('onEndHeaders');
            let newwin = winref.get();
            if ( newwin && newwin.document ) {
              let nowdoc = newwin.document;
              newwin.setTimeout( function() { // use timer as compact header also use listener
                ldapInfo.modifyTooltip4HeaderRows(nowdoc, true);
              }, 0 );
            }
          }
          aWindow.gMessageListeners.push(listener);
        }
      } else if ( typeof(aWindow.gPhotoDisplayHandlers) != 'undefined' && typeof(aWindow.displayPhoto) != 'undefined' ) { // address book
        ldapInfoLog.info('address book hook for displayPhoto');
        aWindow._ldapinfoshow.hookedFunctions.push( ldapInfoaop.around( {target: aWindow, method: 'displayPhoto'}, function(invocation) {
          let [aCard, aImg] = invocation.arguments; // aImg.src now maybe the pic of previous contact
          let win = aImg.ownerDocument.defaultView.window;
          let results = invocation.proceed();
          if ( aCard.primaryEmail && win ) {
            ldapInfo.updateImgWithAddress(aImg, aCard.primaryEmail.toLowerCase(), win, aCard);
          }
          return results;
        })[0] );
      } else if ( typeof(aWindow.gPhotoHandlers) != 'undefined' ) { // address book edit dialog
        ldapInfoLog.info('address book dialog hook for onShow');
        aWindow._ldapinfoshow.hookedFunctions.push( ldapInfoaop.around( {target: aWindow.gPhotoHandlers['generic'], method: 'onShow'}, function(invocation) {
          let [aCard, aDocument, aTargetID] = invocation.arguments; // aCard, document, "photo"
          let aImg = aDocument.getElementById(aTargetID);
          let win = aDocument.defaultView.window;
          let type = aDocument.getElementById("PhotoType").value;
          let results = invocation.proceed();
          let address = aCard.primaryEmail.toLowerCase();
          if ( ldapInfo.cache[address] ) ldapInfo.cache[address].addressbook = {state: 0}; // invalidate cache
          if ( ( type == 'generic' || type == "" ) && aCard.primaryEmail && win ) ldapInfo.updateImgWithAddress(aImg, address, win, aCard);
          return results;
        })[0] );
      } else if ( typeof(aWindow.ComposeFieldsReady) != 'undefined' ) { // compose window
        ldapInfo.initComposeListener(doc);
        //ComposeFieldsReady will call listbox.parentNode.replaceChild(newListBoxNode, listbox);
        aWindow._ldapinfoshow.hookedFunctions.push( ldapInfoaop.after( {target: aWindow, method: 'ComposeFieldsReady'}, function(result) {
          ldapInfoLog.info('ComposeFieldsReady');
          let nowdoc = docref.get();
          if ( nowdoc && nowdoc.getElementById ) ldapInfo.initComposeListener(nowdoc);
          return result;
        })[0] );
        // Compose Window can be recycled, and if it's closed, shutdown can't find it's aWindow and no unLoad is called
        // So we call unLoad when it's closed but become hidden
        if ( typeof(aWindow.gComposeRecyclingListener) != 'undefined' ) {
          ldapInfoLog.info('gComposeRecyclingListener hook for onClose');
          aWindow._ldapinfoshow.hookedFunctions.push( ldapInfoaop.after( {target: aWindow.gComposeRecyclingListener, method: 'onClose'}, function(result) {
            ldapInfoLog.info('compose window onClose');
            let newwin = winref.get();
            if ( newwin && newwin.document ) ldapInfo.unLoad(newwin);
            ldapInfoLog.info('compose window unLoad done');
            return result;
          })[0] );
        }
      }
      if ( aWindow._ldapinfoshow.hookedFunctions.length ) {
        ldapInfoLog.info('create popup');
        this.createPopup(aWindow);
        aWindow.addEventListener("unload", ldapInfo.onUnLoad, false);
      }
    }catch(err) {
      ldapInfoLog.logException(err);
    }
  },
  
  initComposeListener: function(doc) {
    let input = doc.getElementById(composeWindowInputID);
    if ( input ) {
      ldapInfoLog.info('input listener');
      input.addEventListener('focus', ldapInfo.composeWinUpdate, true); // use capture as we are at top
      input.addEventListener('input', ldapInfo.composeWinUpdate, true);
    }
  },
  
  composeWinUpdate: function(event) {
    try {
      let cell = event.target;
      // addressCol2#2
      let splitResult = /^addressCol([\d])#(\d+)/.exec(cell.id);
      if ( splitResult == null ) return;
      let [, col, row] = splitResult;
      let doc = cell.ownerDocument;
      if ( col == 1 ) cell = doc.getElementById('addressCol2#' + row ); //cell.parentNode.nextSibling.firstChild not work with Display Thunderbird Contacts Addon
      if ( !cell || typeof(cell.value) == 'undefined' ) return;
      if ( cell.value == '' && row > 1 ) cell = doc.getElementById('addressCol2#' + (row -1));
      if ( cell.value == '' || cell.value.indexOf('@') < 0 ) return;
      
      let win = doc.defaultView;
      let imageID = boxID + 'compose';
      let image = doc.getElementById(imageID);
      if ( !image ) {
        let refId = 'attachments-box';
        let refEle = doc.getElementById(refId);
        if ( !refEle ){
          ldapInfoLog.info("can't find ref " + refId);
          return;
        }
        let box = doc.createElementNS(XULNS, "vbox");
        box.id = boxID;
        image = doc.createElementNS(XULNS, "image");
        box.insertBefore(image, null);
        refEle.parentNode.insertBefore(box, refEle);
        win._ldapinfoshow.createdElements.push(boxID);
        image.id = imageID;
        image.maxHeight = 128;
      }
      image.setAttribute('src', "chrome://messenger/skin/addressbook/icons/contact-generic.png");
      let email = GlodaUtils.parseMailAddresses(cell.value.toLowerCase()).addresses[0];
      ldapInfo.updateImgWithAddress(image, email, win, null);
    } catch (err) {
      ldapInfoLog.logException(err);  
    }
  },
  
  onUnLoad: function(event) {
    ldapInfoLog.info('onUnLoad');
    let aWindow = event.currentTarget;
    if ( aWindow ) {
      ldapInfo.unLoad(aWindow);
    }
  },

  unLoad: function(aWindow) {
    try {
      ldapInfoLog.info('unload');
      if ( typeof(aWindow._ldapinfoshow) != 'undefined' ) {
        ldapInfoLog.info('unhook');
        aWindow.removeEventListener("unload", ldapInfo.onUnLoad, false);
        aWindow._ldapinfoshow.hookedFunctions.forEach( function(hooked) {
          hooked.unweave();
        } );
        let doc = aWindow.document;
        if ( typeof(aWindow.MessageDisplayWidget) != 'undefined' && typeof(aWindow.gMessageListeners) != 'undefined' ) {
          ldapInfoLog.info('gMessageListeners unregister');
          for( let i = aWindow.gMessageListeners.length - 1; i >= 0; i-- ) {
            let listener = aWindow.gMessageListeners[i];
            if ( listener.winref && listener.winref.get() === aWindow ) {
              ldapInfoLog.info('gMessageListeners unregistr index ' + i);
              aWindow.gMessageListeners.splice(i, 1);
              break;
            }
          }
        }
        if ( aWindow._ldapinfoshow.TCObserver ) {
          Services.obs.removeObserver(aWindow._ldapinfoshow.TCObserver, "Conversations", false);
        }
        let input = doc.getElementById(composeWindowInputID);
        if ( input ) { // compose window
          ldapInfoLog.info('unload compose window listener');
          input.removeEventListener('focus', ldapInfo.composeWinUpdate, true);
          input.removeEventListener('input', ldapInfo.composeWinUpdate, true);
        }
        for ( let node of aWindow._ldapinfoshow.createdElements ) {
          if ( typeof(node) == 'string' ) node = doc.getElementById(node);
          if ( node && node.parentNode ) {
            ldapInfoLog.info("removed node " + node);
            node.parentNode.removeChild(node);
          }
        }
        this.modifyTooltip4HeaderRows(doc, false); // remove
        let image = doc.getElementById(addressBookImageID);
        if ( !image ) image = doc.getElementById(addressBookDialogImageID);
        if ( image ) { // address book
          ldapInfoLog.info('unload addressbook image property');
          delete image.ldap;
          delete image.address;
          delete image.validImage;
          image.removeAttribute('tooltip');
        }
        delete aWindow._ldapinfoshow;
      }
    } catch (err) {
      ldapInfoLog.logException(err);  
    }
    ldapInfoLog.info('unload done');
  },

  cleanup: function() {
    try {
      ldapInfoLog.info('ldapInfo cleanup');
      this.abListener.remove();
      ldapInfoSprintf.sprintf.cache = null;
      ldapInfoSprintf.sprintf = null;
      this.clearCache();
      ldapInfoFetch.cleanup();
      ldapInfoFetchOther.cleanup();
      ldapInfoUtil.cleanup();
      Cu.unload("chrome://ldapInfo/content/aop.jsm");
      Cu.unload("chrome://ldapInfo/content/sprintf.jsm");
      Cu.unload("chrome://ldapInfo/content/ldapInfoFetch.jsm");
      Cu.unload("chrome://ldapInfo/content/ldapInfoFetchOther.jsm");
      Cu.unload("chrome://ldapInfo/content/ldapInfoUtil.jsm");
    } catch (err) {
      ldapInfoLog.logException(err);  
    }
    ldapInfoLog.info('ldapInfo cleanup done');
    Cu.unload("chrome://ldapInfo/content/log.jsm");
    ldapInfoLog = ldapInfoaop = ldapInfoFetch = ldapInfoFetchOther = ldapInfoUtil = ldapInfoSprintf = null;
  },
  
  clearCache: function(clean) {
    if ( clean && allServices.indexOf(clean) >= 0 ) {
      for ( let address of this.cache ) {
        this.cache.address.clean = {state: 0};
      }
      return;
    }
    ldapInfoLog.info('clearCache');
    // can't use this.a = this.b = {}, will make 2 variables point the same place    
    this.cache = {};
    delete this.ldapServers;
    ldapInfoFetch.clearCache();
    ldapInfoFetchOther.clearCache();
  },
  
  updatePopupInfo: function(image, aWindow, headerRow) {
    try {
      ldapInfoLog.info('updatePopupInfo');
      if ( !aWindow || !aWindow.document ) return;
      let doc = aWindow.document;
      let tooltip = doc.getElementById(tooltipID);
      let rows = doc.getElementById(tooltipRowsID);
      if ( !rows || !tooltip || ['showing', 'open'].indexOf(tooltip.state) < 0 ) return;
      if ( tooltip.state == 'open' && typeof(tooltip.address) != 'undefined' && typeof(image) != 'undefined' && tooltip.address != image.address ) return;
      // remove old tooltip
      while (rows.firstChild) {
        rows.removeChild(rows.firstChild);
      }

      let attribute = {};
      if ( image != null && typeof(image) != 'undefined' && image.address && this.cache[image.address] ) {
        let cache = this.cache[image.address];
        tooltip.address = image.address;
        for ( let place of allServices ) {
          if ( ldapInfoUtil.options['load_from_' + place] && cache[place] && cache[place].state == 2 && cache[place].src ) {
            if ( !attribute['_image'] ) attribute['_image'] = []; // so it will be the first one to show
            if ( attribute['_image'].indexOf( cache[place].src ) < 0 ) attribute['_image'].push( cache[place].src );
          }
        }
        attribute['_email'] = [image.address];
        let oneRemote = false;
        for ( let place of allServices ) { // merge all attribute from different sources into attribute
          if ( ldapInfoUtil.options['load_from_' + place] && cache[place] && cache[place].state == 2 ) {
            if ( ['facebook', 'google', 'gravatar'].indexOf(place) >= 0 && !ldapInfoUtil.options.load_from_all_remote ) {
              if (!oneRemote) oneRemote = true; else continue;
            }
            for ( let i in cache[place] ) {
              if ( ['src', 'state'].indexOf(i) >= 0 ) continue;
              if ( place == 'addressbook' && ldapInfoUtil.options.load_from_ldap && cache.ldap.state == 2 && cache.ldap._dn && ( i != '_Status' || !cache.addressbook.src ) ) continue; // ignore attribute in addressbook if has valid ldap info, except _Status
              if ( !attribute[i] ) attribute[i] = [];
              // Error: Caught Exception TypeError: (new Number(200)) is not iterable
              for ( let value of cache[place][i] ) {
                if ( attribute[i].indexOf(value) < 0 ) attribute[i].push(value);
              }
            }
          }
        }
        if ( attribute._Status && attribute._Status[0] != 'Cached' ) {
          if ( !cache.changed ) attribute._Status.unshift('Cached');
          let s = attribute._Status; delete attribute._Status; attribute._Status = s; // move to the last line
        }
      } else if ( headerRow ) {
        attribute = { '': [headerRow.tooltiptextSave || headerRow.getAttribute('fullAddress') || ""] };
      }
      for ( let p in attribute ) {
        let va = attribute[p];
        if ( va.length <= 0 ) continue;
        let v = va[0];
        if ( va.length == 1 && ( typeof(v) == 'undefined' || v == '' ) ) continue;
        if ( va.length > 1 && p != '_image' ) {
          if ( p == "_Status" ) v = va.join(', '); else v = va.sort().join(', ');
        }
        if ( v && typeof(v.toString) == 'function' ) v = v.toString(); // in case v is number, it has no indexOf
        let row = doc.createElementNS(XULNS, "row");
        let col1 = doc.createElementNS(XULNS, "description");
        let col2;
        if ( p == '_image' ) {
          col1.setAttribute('value', '');
          col2 = doc.createElementNS(XULNS, "hbox");
          col2.setAttribute('align', 'end');
          for ( let src of va ) {
            let vbox = doc.createElementNS(XULNS, "vbox");
            let newImage = doc.createElementNS(XULNS, "image");
            newImage.setAttribute('src', src);
            newImage.maxHeight = 128;
            vbox.insertBefore(newImage,null);
            col2.insertBefore(vbox,null);
          }
        } else {
          col1.setAttribute('value', p);
          col2 = doc.createElementNS(XULNS, "description");
          if ( v.length > lineLimit + 10 ) v = v.substr(0, lineLimit) + " [" + (v.length - lineLimit ) + " chars omitted...]"; // ~ 20 lines for 600px, 15 lines for 800px
          //col2.setAttribute('value', v);
          col2.textContent = v; // so it can wrap
          if ( v.indexOf("://") >= 0 ) {
            col2.classList.add("text-link");
            col2.addEventListener('mousedown', function(event){
              ldapInfoUtil.loadUseProtocol(event.target.textContent);
            }, true);
          } else if ( ['telephoneNumber', 'pager','mobile', 'facsimileTelephoneNumber', 'mobileTelephoneNumber', 'pagerTelephoneNumber'].indexOf(p) >= 0 ) {
            col2.classList.add("text-link");
            col2.addEventListener('mousedown', function(event){
              let url = ldapInfoSprintf.sprintf( ldapInfoUtil.options['click2dial'], event.target.textContent );
              ldapInfoUtil.loadUseProtocol(url);
            }, true);
          }
        }
        row.insertBefore(col1, null);
        row.insertBefore(col2, null);
        rows.insertBefore(row, null);
      }
    } catch(err) {  
      ldapInfoLog.logException(err);
    }
  },
  
  ldapCallback: function(callbackData) { // 'this' maybe not ldapInfo
    try {
      ldapInfoLog.info('ldapCallback');
      let my_address = callbackData.address;
      let aImg = callbackData.image;
      if ( my_address == aImg.address ) {
        ldapInfo.setImageSrcFromCache(aImg);
        ldapInfo.updatePopupInfo(aImg, callbackData.win.get(), null);
      }
    } catch (err) {
      ldapInfoLog.logException(err);
    }
  },
  
  loadImageSucceed: function(event) {
    let aImg = event.target;
    if ( !aImg || !aImg.address ) return;
    aImg.removeEventListener('load', ldapInfo.loadImageSucceed, false);
    aImg.removeEventListener('error', ldapInfo.loadImageFailed, false);
  },
  
  loadImageFailed: function(event) {
    let aImg = event.target;
    if ( !aImg || !aImg.address ) return;
    ldapInfoLog.info('loadImageFailed :' + aImg.getAttribute('src'));
    aImg.setAttribute('badsrc', aImg.getAttribute('src'));
    aImg.setAttribute('src', "chrome://messenger/skin/addressbook/icons/remote-addrbook-error.png");
    aImg.validImage = 0;
  },
  
  setImageSrcFromCache: function(image) {
    let cache = this.cache[image.address];
    ldapInfoLog.logObject(cache,'cache in setimg',1);
    if ( typeof( cache ) == 'undefined' ) return;
    for ( let place of allServices ) {
      if ( ldapInfoUtil.options['load_from_' + place] && ( cache[place].state == 2 ) && typeof( cache[place].src ) != 'undefined'
        && servicePriority[place] > image.validImage && ( image.id != addressBookDialogImageID || place != 'addressbook' ) ) {
        image.setAttribute('src', cache[place].src);
        image.validImage = servicePriority[place];
        ldapInfoLog.info('using src of ' + place + " for " + image.address + " from " + cache[place].src.substr(0,100));
        break; // the priority is decrease
      }
    }
  },

  showPhoto: function(aMessageDisplayWidget, folder) {
    try {
      //aMessageDisplayWidget.folderDisplay.selectedMessages array of nsIMsgDBHdr, can be 1
      //                                   .selectedMessageUris array of uri
      //                     .displayedMessage null if mutil, nsImsgDBHdr =>mime2DecodedAuthor,mime2DecodedRecipients [string]
      ldapInfoLog.info("showPhoto");
      if ( !aMessageDisplayWidget ) return;
      let folderDisplay = ( typeof(folder)!='undefined' ) ? folder : aMessageDisplayWidget.folderDisplay;
      if ( !folderDisplay || !folderDisplay.msgWindow ) return;
      let win = folderDisplay.msgWindow.domWindow;
      if ( !win ) return;
      let doc = win.document;
      let addressList = [];
      //let isSingle = aMessageDisplayWidget.singleMessageDisplay; // only works if loadComplete
      let isSingle = (folderDisplay.selectedCount <= 1);
      // check if Thunderbird Conversations Single Mode, which is also multiview
      let isTC = false;
      let TCSelectedHdr = null;
      if ( typeof(win.Conversations) != 'undefined' && win.Conversations.currentConversation
        && win.Conversations.monkeyPatch && win.Conversations.monkeyPatch._undoFuncs && win.Conversations.monkeyPatch._undoFuncs.length) { // check _undoFuncs also as when TC unload currentConversation may still there, a bug
        isTC = true;
        isSingle = false;
        // win.Conversations.currentConversation.msgHdrs && win.Conversations.currentConversation.messages are what we looking for
        win.Conversations.currentConversation.messages.some( function(message) {
          if ( message.message._selected ) {
            TCSelectedHdr = message.message._msgHdr;
            return true;
          }
        } );
      }
      let imageLimit = isSingle ? 36 : 12;
      if ( isSingle ) {
        let deck = doc.getElementById(msgHeaderViewDeck);
        if ( deck && deck.selectedPanel.id != 'expandedHeaderView' ) isSingle = false; // might be compact header, but still use large limit
      }
      let targetMessages = isTC ? win.Conversations.currentConversation.msgHdrs : folderDisplay.selectedMessages;

      for ( let selectMessage of targetMessages ) {
        let who = [];
        let headers = ['author'];
        if ( targetMessages.length <= 1 || ( isTC && TCSelectedHdr === selectMessage ) ) headers = ['author', 'replyTo', 'recipients', 'ccList', 'bccList'];
        headers.forEach( function(header) {
          let headerValue;
          if ( header == 'replyTo' ) { // sometimes work, sometimes not
            headerValue = selectMessage.getStringProperty(header);
          } else {
            headerValue = selectMessage[header];
          }
          if ( typeof(headerValue) != 'undefined' && headerValue != null && headerValue != '' ) who.push( GlodaUtils.deMime(headerValue) );
        } );
        for ( let address of GlodaUtils.parseMailAddresses(who.join(',').toLowerCase()).addresses ) {
          if ( addressList.indexOf(address) < 0 ) {
            addressList.push(address);
          }
          if ( addressList.length >= imageLimit ) break;
        }
        if ( addressList.length >= imageLimit ) break;
      }

      let refId = 'otherActionsBox';
      if ( !isSingle ) refId = 'messagepanebox';
      let refEle = doc.getElementById(refId);
      if ( !refEle ){
        ldapInfoLog.info("can't find ref " + refId);
        return;
      }
      let box = doc.getElementById(boxID);
      if ( !box ) {
        box = doc.createElementNS(XULNS, "box");
        box.id = boxID;
        win._ldapinfoshow.createdElements.push(boxID);
      } else {
        box.parentNode.removeChild(box);
        while (box.firstChild) {
          box.removeChild(box.firstChild);
        }
      }
      box.setAttribute('orient', isSingle ? 'horizontal' : 'vertical'); // use attribute so my css attribute selector works
      refEle.parentNode.insertBefore(box, isSingle ? refEle : null);
      
      for ( let address of addressList ) {
        ldapInfoLog.info('show image for ' + address);
        // use XUL image element for chrome://generic.png
        // image within html doc won't ask password
        let image = doc.createElementNS(XULNS, "image");
        let innerbox = doc.createElementNS(XULNS, isSingle ? "vbox" : "hbox"); // prevent from image resize
        innerbox.insertBefore(image, null);
        box.insertBefore(innerbox, null);
        image.id = boxID + address; // for header row to find me
        image.maxHeight = addressList.length <= 8 ? 64 : 48;
        image.setAttribute('src', "chrome://messenger/skin/addressbook/icons/contact-generic-tiny.png");
        ldapInfo.updateImgWithAddress(image, address, win, null);
      } // all addresses
      
      if ( isTC ) { // for TB Conversations Contacts
        let browser = doc.getElementById('multimessage');
        if ( !browser || !browser._docShell ) return;
        let htmldoc = browser._docShell.QueryInterface(Ci.nsIDocShell).contentViewer.DOMDocument;
        if ( !htmldoc ) return;
        let messageList = htmldoc.getElementById('messageList');
        if ( !messageList ) return;
        let letImageDivs = messageList.getElementsByClassName('authorPicture');
        Array.forEach(letImageDivs, function(imageDiv) {
          for ( let imageNode of imageDiv.childNodes ) {
            if ( imageNode.nodeName == 'img' && typeof(imageNode.changedImage) == 'undefined' ) { // finally got it
              imageNode.changedImage = true;
              let src = imageNode.getAttribute('src');
              if ( src && src.indexOf("chrome:") == 0 ) {
                let authorEmail = imageDiv.previousElementSibling.getElementsByClassName('authorEmail');
                if ( typeof(authorEmail) == 'undefined' ) continue;
                authorEmail = authorEmail[0].textContent.trim().toLowerCase();
                ldapInfoLog.info('Find TB Conversations Contacts: ' + authorEmail);
                ldapInfo.updateImgWithAddress(imageNode, authorEmail, win, null);
              }
            }
          }
        } );
      }
      
    } catch(err) {
        ldapInfoLog.logException(err);
    }
  },
  
  updateImgWithAddress: function(image, address, win, card) {
    try {
      if ( typeof( ldapInfo.ldapServers ) == 'undefined' ) ldapInfo.getLDAPFromAB();
      // For address book, it reuse the same iamge, so can't use image as data container because user may quickly change the selected card
      image.address = address; // used in callback verification, still the same address?
      image.tooltip = tooltipID;
      image.validImage = 0;
      image.addEventListener('error', ldapInfo.loadImageFailed, false); // duplicate listener will be discard
      image.addEventListener('load', ldapInfo.loadImageSucceed, false);
      
      let cache = this.cache[address];
      if ( typeof( this.cache[address] ) == 'undefined' ) { // create empty one
        cache = this.cache[address] = {}; // same object
        allServices.forEach( function(place) {
          cache[place] = {state: 0};
        } );
      }
      //cache['local_dir'].state = 0; the state will only be 2 if succeed in getPhotoFromLocalDir
      ldapInfoLog.logObject(cache,'cache',1);
      if ( [addressBookImageID, addressBookDialogImageID].indexOf(image.id) >= 0 ) {
        if ( typeof(win.defaultPhotoURI) != 'undefined' && image.getAttribute('src') != win.defaultPhotoURI ) { // addressbook item has photo
          image.validImage = servicePriority.addressbook;
        }
      }
      let callbackData = { image: image, address: address, win: Cu.getWeakReference(win), callback: ldapInfo.ldapCallback, cache: cache };
      let changed = false, useLDAP = false, mailid, mailDomain;
      let match = address.match(/(\S+)@(\S+)/);
      if ( match && match.length == 3 ) [, mailid, mailDomain] = match;
      for ( let place of allServices ) {
        if ( ldapInfoUtil.options['load_from_' + place] && cache[place].state <= 1 ) {
          ldapInfoLog.info('try ' + place);
          if ( place == 'local_dir') {
            changed |= ldapInfo.getPhotoFromLocalDir(address, callbackData); // will change cache sync
          } else if ( place == 'addressbook') {
            changed = true;
            ldapInfo.getPhotoFromAB(address, callbackData); // will change cache sync
          } else if ( place == 'ldap') {
            let [ldapServer, filter, baseDN, uuid, ldapCard] = [null, null, null, null, null];
            let scope = Ci.nsILDAPURL.SCOPE_SUBTREE;
            if ( card ) { // get LDAP server from card itself to avoid using wrong servers
              if ( card.directoryId && card.QueryInterface ) { // card detail dialog
                try {
                  ldapCard = card.QueryInterface(Ci.nsIAbLDAPCard);
                } catch(err) {}; // might be NOINTERFACE
                if ( ldapCard ) {
                  filter = '(objectclass=*)';
                  baseDN = ldapCard.dn;
                  scope = Ci.nsILDAPURL.SCOPE_BASE;
                  uuid = ldapCard.directoryId;
                }
              }
              if ( !uuid && win.gDirectoryTreeView && win.gDirTree && win.gDirTree.currentIndex > 0 ) {
                uuid = win.gDirectoryTreeView.getDirectoryAtIndex(win.gDirTree.currentIndex).uuid;
              }
              if ( uuid && typeof(ldapInfo.ldapServers[uuid]) != 'undefined' ) ldapServer = ldapInfo.ldapServers[uuid];
            }
            if ( !ldapServer ) { // try to match mailDomain
              for ( let id in ldapInfo.ldapServers ) {
                if ( ldapInfo.ldapServers[id]['prePath'].toLowerCase().indexOf('.' + mailDomain) >= 0 || ldapInfo.ldapServers[id]['baseDn'].indexOf(mailDomain) >= 0 || ldapInfo.ldapServers[id]['dirName'].indexOf(mailDomain) >= 0 ) {
                  ldapServer = ldapInfo.ldapServers[id];
                  break;
                }
              }
            }
            if ( !ldapServer && ldapInfoUtil.options.ldap_ignore_domain ) {
              for ( let id in ldapInfo.ldapServers ) {
                ldapServer = ldapInfo.ldapServers[id];
                break;
              }
            }
            if ( ldapServer ) {
              if ( !filter ) {
                try {
                  let parameter = {email: address, uid: mailid, domain: mailDomain};
                  // filter: (|(mail=*spe*)(cn=*spe*)(givenName=*spe*)(sn=*spe*))
                  filter = ldapInfoSprintf.sprintf( ldapInfoUtil.options.filterTemplate, parameter );
                } catch (err) {
                  ldapInfoLog.log("filterTemplate is not correct: " + ldapInfoUtil.options.filterTemplate, "Exception");
                  break;
                }
              }
              if ( !baseDN ) baseDN = ldapServer.baseDn;
              changed = useLDAP = true;
              cache.ldap.state = 1;
              ldapInfoFetch.queueFetchLDAPInfo(callbackData, ldapServer.host, ldapServer.prePath, baseDN, ldapServer.authDn, filter, ldapInfoUtil.options.ldap_attributes, scope);
            } else {
              cache.ldap.state = 2; // no ldap server
              cache.ldap._Status = ["No LDAP server avaliable"];
            }
          } else { // fetch other
            if ( ( useLDAP || cache.ldap.state == 1 || ( cache.ldap.state == 2 && cache.ldap._dn ) ) && !ldapInfoUtil.options.load_from_remote_always ) break;
            if ( !ldapInfoUtil.options.load_from_all_remote && ( ( ldapInfoUtil.options.load_from_facebook && cache.facebook.src )
                                                              || ( ldapInfoUtil.options.load_from_google && cache.google.src )
                                                              || ( ldapInfoUtil.options.load_from_gravatar && cache.gravatar.src ) ) ) break;
            if ( ! ( ldapInfoUtil.options.load_from_facebook || ldapInfoUtil.options.load_from_google || ldapInfoUtil.options.load_from_gravatar ) ) break;
            callbackData.mailid = mailid;
            callbackData.mailDomain = mailDomain;
            changed = true;
            ldapInfoFetchOther.queueFetchOtherInfo(callbackData);
            break;
          }
        } // need load
      } // all services
      cache.changed = changed;
      ldapInfoLog.info('cached.changed ' + changed);
      this.setImageSrcFromCache(image);
      this.updatePopupInfo(image, win, null);
    } catch(err) {
       ldapInfoLog.logException(err);
    }
  },

};
