import { MODULE_ID } from "./constants.mjs";

/** World setting: carry points beyond a crafting project's goal into the next one. */
export const CARRY_OVER_SETTING = "carryOverPoints";

/** Flag on a project holding a copy of what it yields, used if the original can no longer be found. */
export const YIELD_FLAG = "yieldData";

/** Key added to update options to remember a project's points before the update. */
const PREVIOUS_POINTS = "dsPartyInventoryPreviousPoints";

/** Pending completions per party, so that several in a row stack instead of racing each other. */
const queues = new WeakMap();

const log = (...args) => console.log(`${MODULE_ID} |`, ...args);

/* -------------------------------------------------- */

/**
 * Register this feature's setting.
 */
export function registerCarryOverSetting() {
  game.settings.register(MODULE_ID, CARRY_OVER_SETTING, {
    name: "DSPI.Settings.CarryOver.Name",
    hint: "DSPI.Settings.CarryOver.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });
}

/* -------------------------------------------------- */
/*   Starting a crafting project                      */
/* -------------------------------------------------- */

/**
 * Build the creation data for a project that crafts a treasure or an imbuement.
 * The system fills most of this in itself from `system.yield.document`; it is spelled out here as well so the
 * project is complete even if that lookup does not happen, and a copy of the yielded document is kept on the
 * project in case the original is later moved or deleted.
 * @param {Item|ActiveEffect} source   A treasure item or an imbuement effect.
 * @returns {object}
 */
export function craftingProjectData(source) {
  const project = source.system?.project ?? {};
  const isItem = source.documentName === "Item";
  const snapshot = isItem ? game.items.fromCompendium(source, { clearFolder: true }) : source.toObject();

  return {
    name: game.i18n.format("DRAW_STEEL.Item.project.Craft.ItemName", { name: source.name }),
    type: "project",
    img: source.img,
    system: {
      type: "crafting",
      prerequisites: project.prerequisites ?? "",
      projectSource: project.source ?? "",
      rollCharacteristic: Array.from(project.rollCharacteristic ?? []),
      goal: project.goal || null,
      yield: {
        document: source.uuid,
        amount: project.yield?.amount || "1",
        display: project.yield?.display ?? "",
      },
    },
    flags: { [MODULE_ID]: { [YIELD_FLAG]: { documentName: source.documentName, data: snapshot } } },
  };
}

/* -------------------------------------------------- */

/**
 * Start a crafting project on a party for a treasure or imbuement.
 * @param {Actor} party                A party actor.
 * @param {Item|ActiveEffect} source   What the project will produce.
 * @returns {Promise<Item|undefined>}  The created project.
 */
export async function createCraftingProject(party, source) {
  return getDocumentClass("Item").create(craftingProjectData(source), { parent: party });
}

/* -------------------------------------------------- */
/*   Completing a crafting project                    */
/* -------------------------------------------------- */

/**
 * Find what a project yields: the linked document if it still exists, otherwise the copy kept on the project.
 * @param {Item} project
 * @returns {Promise<{ documentName: string, document: Item|ActiveEffect|null, data: object|null }|null>}
 */
async function resolveYield(project) {
  const uuid = project.system.yield?.document;
  let document = null;
  if (uuid) {
    try {
      document = await fromUuid(uuid);
    } catch (err) {
      log(`Could not load ${uuid}.`, err);
    }
  }
  if (document) return { documentName: document.documentName, document, data: null };

  const snapshot = project.getFlag(MODULE_ID, YIELD_FLAG);
  if (snapshot?.data) {
    if (uuid) log(`${uuid} no longer exists; using the copy stored on "${project.name}".`);
    return { documentName: snapshot.documentName, document: null, data: snapshot.data };
  }
  return null;
}

/* -------------------------------------------------- */

/**
 * Put what a completed project yields into the party's inventory.
 * Replaces the system's own completion for projects owned by a party: that one is started without being
 * awaited, so when anything goes wrong the item silently never appears.
 * @param {Item} project   A completed project owned by a party.
 * @returns {Promise<number>}  How many were crafted (0 if the project yields nothing).
 */
async function grantYield(project) {
  const party = project.actor;
  const system = project.system;
  const found = await resolveYield(project);

  if (!found) {
    if (system.yield?.document) {
      ui.notifications.error("DSPI.Crafting.MissingYield", { format: { project: project.name } });
      log(`"${project.name}" was completed, but its yield ${system.yield.document} could not be found.`);
    } else log(`"${project.name}" was completed. It has no linked item, so nothing was added to the inventory.`);
    return 0;
  }

  const roll = await new ds.rolls.DSRoll(String(system.yield?.amount || "1")).evaluate();
  const amount = Math.max(1, Math.floor(Number(roll.total) || 0));
  const name = found.document?.name ?? found.data.name;

  if (found.documentName === "ActiveEffect") {
    // Imbuements need the system's own prompt for which treasure receives them.
    const effect = found.document ?? new (getDocumentClass("ActiveEffect"))(found.data);
    await system._createCraftedEffect(effect, amount);
  } else {
    const data = found.data ?? game.items.fromCompendium(found.document, { clearFolder: true });
    const dsid = found.document?.dsid ?? data.system?._dsid ?? getDocumentClass("Item").generateDSID(data.name);
    const leveled = data.system?.category === "leveled";
    const existing = leveled ? null : party.items.find(i => (i.type === "treasure") && (i.dsid === dsid));

    if (existing) {
      await existing.update({ "system.quantity": (existing.system.quantity ?? 0) + amount });
      log(`"${project.name}" completed: ${existing.name} in ${party.name} raised by ${amount}.`);
    } else {
      foundry.utils.setProperty(data, "system.quantity", amount);
      const [created] = await party.createEmbeddedDocuments("Item", [data]);
      if (!created) {
        ui.notifications.error("DSPI.Crafting.CreateFailed", { format: { item: name, project: project.name } });
        log(`"${project.name}" completed, but creating ${name} on ${party.name} was refused.`);
        return 0;
      }
      log(`"${project.name}" completed: ${amount} × ${created.name} added to ${party.name}.`);
    }
  }

  const plural = game.i18n.pluralRules?.select(amount) ?? "other";
  ui.notifications.success(`DRAW_STEEL.Item.project.Craft.CompletedNotification.${plural}`, {
    format: { actor: party.name, amount, item: name },
  });
  return amount;
}

/* -------------------------------------------------- */

/**
 * Work out what happens to the points beyond a project's goal.
 * @param {number} points   The project's points after the roll.
 * @param {number} goal     The project's goal.
 * @returns {{ extraCompletions: number, remainder: number }}
 */
export function splitExcess(points, goal) {
  const excess = Math.max(0, points - goal);
  return { extraCompletions: Math.floor(excess / goal), remainder: excess % goal };
}

/* -------------------------------------------------- */

/**
 * Handle a party project reaching its goal: grant what it yields and, if the setting is on,
 * start it again with the spare points (yielding again for each time they cover the goal).
 * @param {Item} project   A just-completed project owned by a party.
 * @returns {Promise<void>}
 */
async function completePartyProject(project) {
  const { goal, points } = project.system;
  const crafted = await grantYield(project);
  if (!crafted || !game.settings.get(MODULE_ID, CARRY_OVER_SETTING)) return;

  const { extraCompletions, remainder } = splitExcess(points, goal);
  if (!extraCompletions && !remainder) return;

  for (let i = 0; i < extraCompletions; i++) await grantYield(project);

  // With nothing left over, the last completion stands and the project stays finished.
  await project.update({ "system.points": remainder || goal });
  if (remainder) {
    ui.notifications.info("DSPI.CarryOver.Done", { format: { points: remainder, project: project.name } });
    log(`${remainder} spare points carried over on "${project.name}".`);
  }
}

/* -------------------------------------------------- */
/*   Hooks and patches                                */
/* -------------------------------------------------- */

/**
 * preUpdateItem hook: remember a party project's points before they change.
 * @param {Item} item         The item about to be updated.
 * @param {object} changes    The requested changes.
 * @param {object} options    Update options, shared with the later updateItem hook on this client.
 */
export function onPreUpdateItem(item, changes, options) {
  if ((item.type !== "project") || (item.actor?.type !== "party")) return;
  if (foundry.utils.hasProperty(changes, "system.points")) options[PREVIOUS_POINTS] = item.system.points ?? 0;
}

/* -------------------------------------------------- */

/**
 * updateItem hook: on the client that made the change, complete a party project whose points reached its goal.
 * @param {Item} item         The updated item.
 * @param {object} changed    The differential update.
 * @param {object} options    Update options.
 * @param {string} userId     The id of the user who made the update.
 */
export function onUpdateItem(item, changed, options, userId) {
  if (userId !== game.userId) return;
  if ((item.type !== "project") || (item.actor?.type !== "party")) return;

  const goal = item.system.goal;
  const previous = options?.[PREVIOUS_POINTS];
  // Fall back on the system's own flag if the earlier hook did not see this update.
  const completed = (previous === undefined)
    ? !!options?.completeProject
    : (!!goal && (previous < goal) && (item.system.points >= goal));
  if (!completed) return;

  const party = item.actor;
  const next = (queues.get(party) ?? Promise.resolve())
    .then(() => completePartyProject(item))
    .catch(err => {
      ui.notifications.error("DSPI.Crafting.Failed", { format: { project: item.name } });
      console.error(`${MODULE_ID} | Completing "${item.name}" failed.`, err);
    });
  queues.set(party, next);
}

/* -------------------------------------------------- */

/**
 * Stop the system's ProjectModel#completeCraftingProject from running for projects owned by a party,
 * since this module grants the yield itself. Projects owned by anything else are untouched.
 */
export function patchCraftingCompletion() {
  const ProjectModel = CONFIG.Item.dataModels?.project;
  const original = ProjectModel?.prototype?.completeCraftingProject;
  if (typeof original !== "function") {
    console.warn(`${MODULE_ID} | The Draw Steel crafting completion method was not found; nothing to override.`);
    return;
  }
  if (original._dsPartyInventory) return;

  function completeCraftingProject(...args) {
    if (this.actor?.type === "party") return Promise.resolve();
    return original.apply(this, args);
  }
  completeCraftingProject._dsPartyInventory = true;

  ProjectModel.prototype.completeCraftingProject = completeCraftingProject;
}
