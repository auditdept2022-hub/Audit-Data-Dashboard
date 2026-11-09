/* Optional standalone form of the v232 navigation helper. The HTML pages also
   embed this logic so they remain functional when this file is not deployed. */
(function (window, document) {
  'use strict';
  var HOME_KEY = 'auditDashboard.homeUrl.v232';
  var LEGACY = ['auditDashboard.homeUrl.v230','auditDashboard:homeUrl:v230','auditDashboardHomeUrl','audit-dashboard-home-url'];
  var APPS = {'attendance_dashboard.html':1,'Data-updater.html':1,'Opex.html':1,'Parts_Request.html':1};
  var APP_PATH = /\/(?:attendance_dashboard|data-updater|opex|parts_request)\.html$/i;
  function get(n,k){try{var s=window[n];return s&&s.getItem(k)||''}catch(e){return ''}}
  function set(n,k,v){try{var s=window[n];if(s)s.setItem(k,v)}catch(e){}}
  function safe(v){try{var u=new URL(v,location.href);return u.origin===location.origin&&!APP_PATH.test(u.pathname)&&/^https?:$/.test(u.protocol)?u:null}catch(e){return null}}
  function remember(){if(APP_PATH.test(location.pathname||''))return get('sessionStorage',HOME_KEY)||get('localStorage',HOME_KEY);var u=new URL(location.href);u.hash='';var v=u.href;set('sessionStorage',HOME_KEY,v);set('localStorage',HOME_KEY,v);LEGACY.forEach(function(k){set('sessionStorage',k,v);set('localStorage',k,v)});return v}
  function home(){var a=[get('sessionStorage',HOME_KEY),get('localStorage',HOME_KEY)];LEGACY.forEach(function(k){a.push(get('sessionStorage',k),get('localStorage',k))});if(document.referrer)a.push(document.referrer);for(var i=0;i<a.length;i++){var u=safe(a[i]);if(u)return u.href}var f=new URL('./index.html',location.href);f.searchParams.set('skipLoading','1');return f.href}
  window.rememberDashboardHomeUrl=remember;
  window.getDashboardHomeUrl=home;
  window.navigateToSubApp=function(file){if(!APPS[String(file||'')])return false;remember();location.assign(new URL(String(file),location.href).href);return false};
  window.navigateToDashboardHome=function(e){if(e&&e.preventDefault)e.preventDefault();location.assign(home());return false};
  if(!APP_PATH.test(location.pathname||''))remember();
})(window,document);
