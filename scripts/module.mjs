import { MODULE_ID } from "./constants.mjs";
import createPartyInventorySheet from "./party-sheet.mjs";
import { addDepositButtons, depositToParty, giveToMember } from "./transfer.mjs";
import { createCraftingProject, onPreUpdateItem, onUpdateItem, patchCraftingCompletion, registerCarryOverSetting } from "./crafting.mjs";
import { chooseRoller, getPartyHeroes, patchProjectRollPrompt, rollPartyProject, spendPartyCareerPoints } from "./rolls.mjs";

/** The id Foundry gives the registered sheet: `${scope}.${class name}`. */
let sheetId = null;

/* -------------------------------------------------- */

Hooks.once("init", () => {
  if (game.system.id !== "draw-steel") return;

  registerCarryOverSetting();

  const sheetClass = createPartyInventorySheet();
  if (!sheetClass) return;

  foundry.documents.collections.Actors.registerSheet(MODULE_ID, sheetClass, {
    types: ["party"],
    makeDefault: true,
    label: "DSPI.SheetLabel",
  });
  sheetId = `${MODULE_ID}.${sheetClass.name}`;

  game.modules.get(MODULE_ID).api = {
    sheetClass,
    getPartyHeroes,
    chooseRoller,
    rollPartyProject,
    spendPartyCareerPoints,
    giveToMember,
    depositToParty,
    createCraftingProject,
  };

  // Hand button on the hero sheet's Equipment tab, and completion of party projects
  Hooks.on("renderDrawSteelHeroSheet", addDepositButtons);
  Hooks.on("preUpdateItem", onPreUpdateItem);
  Hooks.on("updateItem", onUpdateItem);
});

/* -------------------------------------------------- */

/**
 * Make this module's sheet the default party sheet even if the system registered its own afterwards.
 * A sheet the Director or a player picked through "Configure Sheet" is stored separately and still wins.
 */
function ensureDefaultSheet() {
  const classes = CONFIG.Actor.sheetClasses?.party;
  if (!sheetId || !classes?.[sheetId]) return;
  for (const [id, config] of Object.entries(classes)) config.default = id === sheetId;
}

/* -------------------------------------------------- */

Hooks.once("setup", () => {
  if (game.system.id !== "draw-steel") return;
  // The system's data models are registered during its own init, which may run after this module's.
  patchProjectRollPrompt();
  patchCraftingCompletion();
  ensureDefaultSheet();
});

Hooks.once("ready", ensureDefaultSheet);
