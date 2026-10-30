// Single import point for Webix (GPL "standard" edition from npm).
// Webix is a UMD bundle; expose it on window as well because some Webix
// templates and inline handlers reference the global `webix` object.
import * as webixModule from 'webix';

const webix = webixModule.default ?? webixModule;
if (typeof window !== 'undefined') window.webix = webix;

export default webix;
