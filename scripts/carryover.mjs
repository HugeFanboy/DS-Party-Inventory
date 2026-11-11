import { MODULE_ID } from "./constants.mjs";

/** World setting: carry points beyond a crafting project's goal into the next one. */
export const CARRY_OVER_SETTING = "carryOverPoints";

/** Pending crafting completions per party, so that several in a row stack instead of racing each other. */
const queues = new WeakMap();

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

/**
 * Make the system's ProjectModel#completeCraftingProject run one at a time per party.
 * The system starts it without waiting for it; when carry-over completes a project more than once,
 * running them together could create two inventory rows instead of one stack.
 * Projects owned by anything other than a party are untouched.
 */
export function patchCraftingCompletion() {
  const ProjectModel = CONFIG.Item.dataModels?.project;
  const original = ProjectModel?.prototype?.completeCraftingProject;
  if (typeof original !== "function") {
    console.error(`${MODULE_ID} | Could not find the Draw Steel crafting completion method; carry-over is unavailable.`);
    return;
  }
  if (original._dsPartyInventory) return;

  function completeCraftingProject(...args) {
    const actor = this.actor;
    if (actor?.type !== "party") return original.apply(this, args);

    const previous = queues.get(actor) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => original.apply(this, args));
    queues.set(actor, next);
    return next;
  }
  completeCraftingProject._dsPartyInventory = true;

  ProjectModel.prototype.completeCraftingProject = completeCraftingProject;
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
 * After a party's crafting project is completed with points to spare, start it again with those points.
 * If the spare points cover the goal again, the project yields again for each time they do.
 * @param {Item} project   A just-completed project owned by a party.
 * @returns {Promise<void>}
 */
export async function carryOverPoints(project) {
  const { goal, points } = project.system;
  if (!goal || !project.system.yield?.document) return;

  const { extraCompletions, remainder } = splitExcess(points, goal);
  if (!extraCompletions && !remainder) return;

  // The system has already begun the first completion; these wait their turn behind it.
  for (let i = 0; i < extraCompletions; i++) await project.system.completeCraftingProject();

  // With nothing left over, the last completion stands and the project stays finished.
  await project.update({ "system.points": remainder || goal });

  if (remainder) {
    ui.notifications.info("DSPI.CarryOver.Done", { format: { points: remainder, project: project.name } });
  }
}

/* -------------------------------------------------- */

/**
 * updateItem hook: react to the completion of a party's crafting project on the client that caused it.
 * @param {Item} item         The updated item.
 * @param {object} changed    The differential update.
 * @param {object} options    Update options; the system sets `completeProject` when a goal is reached.
 * @param {string} userId     The id of the user who made the update.
 */
export function onUpdateItem(item, changed, options, userId) {
  if ((userId !== game.userId) || !options?.completeProject) return;
  if ((item.type !== "project") || (item.actor?.type !== "party")) return;
  if (!game.settings.get(MODULE_ID, CARRY_OVER_SETTING)) return;
  carryOverPoints(item).catch(err => console.error(`${MODULE_ID} | Carrying over project points failed.`, err));
}
