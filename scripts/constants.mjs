export const MODULE_ID = "ds-party-inventory";

/** Item types a party is allowed to hold. */
export const PARTY_ITEM_TYPES = new Set(["treasure", "project"]);

/** Part and tab ids added by this module. "projects" is avoided: the system strips that tab from non-hero sheets. */
export const TAB_INVENTORY = "inventory";
export const TAB_PROJECTS = "partyProjects";

/**
 * Build a path to a file inside this module.
 * @param {string} path
 * @returns {string}
 */
export const modulePath = (path) => `modules/${MODULE_ID}/${path}`;
