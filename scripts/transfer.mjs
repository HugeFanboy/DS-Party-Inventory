import { MODULE_ID } from "./constants.mjs";

/** The flag on a party actor that stores its transfer record. */
export const LOG_FLAG = "transferLog";

/** How many transfers a party remembers. Older entries are dropped. */
export const LOG_LIMIT = 200;

/* -------------------------------------------------- */
/*   Transfer record                                  */
/* -------------------------------------------------- */

/**
 * @typedef TransferLogEntry
 * @property {number} time        When it happened (ms since epoch).
 * @property {string} user        Name of the user who did it.
 * @property {"give"|"deposit"} direction   "give" is stash to hero, "deposit" is hero to stash.
 * @property {string} actor       Name of the hero involved.
 * @property {string} item        Name of the item.
 * @property {number} quantity    How many were moved.
 */

/**
 * Read a party's transfer record, oldest first.
 * @param {Actor} party
 * @returns {TransferLogEntry[]}
 */
export function getTransferLog(party) {
  const log = party?.getFlag(MODULE_ID, LOG_FLAG);
  return Array.isArray(log) ? log : [];
}

/* -------------------------------------------------- */

/**
 * Add an entry to a party's transfer record. Names are stored as text so the record survives deletions.
 * @param {Actor} party
 * @param {Pick<TransferLogEntry, "direction"|"actor"|"item"|"quantity">} entry
 * @returns {Promise<void>}
 */
async function recordTransfer(party, entry) {
  try {
    const log = getTransferLog(party).slice(-(LOG_LIMIT - 1));
    log.push({ time: Date.now(), user: game.user.name, ...entry });
    await party.setFlag(MODULE_ID, LOG_FLAG, log);
  } catch (err) {
    // The items have already moved; a failed note must not look like a failed transfer.
    console.error(`${MODULE_ID} | Could not record a transfer.`, err);
  }
}

/* -------------------------------------------------- */

/**
 * Erase a party's transfer record.
 * @param {Actor} party
 * @returns {Promise<Actor>}
 */
export function clearTransferLog(party) {
  return party.unsetFlag(MODULE_ID, LOG_FLAG);
}

/* -------------------------------------------------- */
/*   Moving items                                     */
/* -------------------------------------------------- */

/**
 * Find a treasure on an actor that the given one can be stacked onto.
 * Leveled treasures are never stacked, since each can carry its own imbuements.
 * @param {Item} item     The treasure being moved.
 * @param {Actor} actor   The actor receiving it.
 * @returns {Item|undefined}
 */
function findStack(item, actor) {
  if (item.system.category === "leveled") return undefined;
  return actor.items.find(i => (i.type === "treasure") && (i.dsid === item.dsid) && (i.name === item.name));
}

/* -------------------------------------------------- */

/**
 * Move some quantity of a treasure onto another actor.
 * The destination is updated first, so an interruption can duplicate an item but never lose one.
 * @param {Item} item         The treasure to move.
 * @param {Actor} target      The actor receiving it.
 * @param {number} quantity   How many to move.
 * @returns {Promise<number>} How many were moved.
 */
async function moveTreasure(item, target, quantity) {
  const available = item.system.quantity ?? 0;
  quantity = Math.clamp(Math.floor(Number(quantity) || 0), 0, available);
  if (quantity <= 0) return 0;

  const stack = findStack(item, target);
  if (stack) await stack.update({ "system.quantity": (stack.system.quantity ?? 0) + quantity });
  else {
    const itemData = game.items.fromCompendium(item, { clearFolder: true });
    foundry.utils.setProperty(itemData, "system.quantity", quantity);
    const [created] = await target.createEmbeddedDocuments("Item", [itemData]);
    if (!created) return 0;
  }

  if (quantity >= available) await item.delete();
  else await item.update({ "system.quantity": available - quantity });

  return quantity;
}

/* -------------------------------------------------- */

/**
 * Ask who gets an item and how many. Either question is skipped when it has only one answer.
 * @param {object} config
 * @param {string} config.title                 Dialog title.
 * @param {string} config.targetLabel           Label for the actor choice.
 * @param {Actor[]} config.targets              Actors to choose from. Must not be empty.
 * @param {number} config.available             How many there are to move.
 * @param {string} config.availableHint         Hint shown under the quantity.
 * @param {string} [config.preferred]           Id of the actor to preselect.
 * @returns {Promise<{ target: Actor, quantity: number }|null>}
 */
async function promptTransfer({ title, targetLabel, targets, available, availableHint, preferred }) {
  if ((targets.length === 1) && (available === 1)) return { target: targets[0], quantity: 1 };

  const { createFormGroup, createSelectInput, createNumberInput } = foundry.applications.fields;
  const content = document.createElement("div");

  if (targets.length > 1) {
    const value = targets.some(a => a.id === preferred) ? preferred : targets[0].id;
    content.append(createFormGroup({
      label: targetLabel,
      localize: true,
      input: createSelectInput({
        name: "target",
        value,
        options: targets.map(a => ({ value: a.id, label: a.name, selected: a.id === value })),
      }),
    }));
  }
  if (available > 1) {
    content.append(createFormGroup({
      label: "DSPI.Transfer.Quantity",
      hint: availableHint,
      localize: true,
      input: createNumberInput({ name: "quantity", value: 1, min: 1, max: available, step: 1 }),
    }));
  }

  const fd = await ds.applications.api.DSDialog.input({
    content,
    window: { title, icon: "fa-solid fa-hand-holding-hand" },
  });
  if (!fd) return null;

  const target = (targets.length > 1) ? targets.find(a => a.id === fd.target) : targets[0];
  if (!target) return null;
  return { target, quantity: Number(fd.quantity ?? 1) };
}

/* -------------------------------------------------- */
/*   Stash to hero                                    */
/* -------------------------------------------------- */

/**
 * The party members the current user can hand treasure to: members whose sheet they own.
 * A Director can give to anyone; a player can take things for their own characters.
 * @param {Actor} party   A party actor.
 * @returns {Actor[]}     Actors sorted by name.
 */
export function getRecipients(party) {
  const recipients = [];
  for (const member of party?.system?.members ?? []) {
    const actor = member?.actor;
    if (actor?.isOwner) recipients.push(actor);
  }
  return recipients.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
}

/* -------------------------------------------------- */

/**
 * Can the current user give this item to somebody?
 * @param {Item} item   An item on a party.
 * @returns {boolean}
 */
export function canGive(item) {
  if ((item?.type !== "treasure") || (item.actor?.type !== "party") || !item.isOwner) return false;
  return ((item.system.quantity ?? 0) > 0) && (getRecipients(item.actor).length > 0);
}

/* -------------------------------------------------- */

/**
 * Move some quantity of a treasure from the party stash to a party member.
 * @param {Item} item                       A treasure owned by a party.
 * @param {object} [options]
 * @param {Actor} [options.recipient]       Skip the prompt and give to this actor.
 * @param {number} [options.quantity]       Skip the prompt and give this many.
 * @returns {Promise<{ recipient: Actor, quantity: number }|null>}  What was given, or null if nothing was.
 */
export async function giveToMember(item, { recipient, quantity } = {}) {
  if ((item?.type !== "treasure") || (item.actor?.type !== "party") || !item.isOwner) return null;
  const party = item.actor;
  const name = item.name;
  const available = item.system.quantity ?? 0;
  if (available <= 0) return null;

  if (!recipient || !quantity) {
    const targets = recipient ? [recipient] : getRecipients(party);
    if (!targets.length) {
      ui.notifications.warn("DSPI.Give.NoRecipients", { localize: true });
      return null;
    }
    const choice = await promptTransfer({
      targets,
      available,
      title: game.i18n.format("DSPI.Give.Title", { item: name }),
      targetLabel: "DSPI.Give.Recipient",
      availableHint: game.i18n.format("DSPI.Give.QuantityHint", { available }),
      preferred: game.user.character?.id,
    });
    if (!choice) return null;
    recipient = choice.target;
    quantity ??= choice.quantity;
  }

  if (!recipient?.isOwner) return null;
  const moved = await moveTreasure(item, recipient, quantity);
  if (!moved) return null;

  await recordTransfer(party, { direction: "give", actor: recipient.name, item: name, quantity: moved });
  ui.notifications.info("DSPI.Give.Done", { format: { recipient: recipient.name, quantity: moved, item: name } });

  return { recipient, quantity: moved };
}

/* -------------------------------------------------- */
/*   Hero to stash                                    */
/* -------------------------------------------------- */

/**
 * The parties a character could put treasure into: parties it belongs to that the current user owns.
 * @param {Actor} actor   A hero (or other possible party member).
 * @returns {Actor[]}     Parties, the primary party first.
 */
export function getDepositParties(actor) {
  if (!actor || actor.inCompendium) return [];
  const primary = game.actors.party;
  return game.actors
    .filter(a => (a.type === "party") && a.isOwner && a.system.members?.has(actor.id))
    .sort((a, b) => ((b === primary) - (a === primary)) || a.name.localeCompare(b.name, game.i18n.lang));
}

/* -------------------------------------------------- */

/**
 * Can the current user put this item into a party's stash?
 * @param {Item} item   An item on a hero.
 * @returns {boolean}
 */
export function canDeposit(item) {
  const actor = item?.actor;
  if ((item?.type !== "treasure") || !actor || (actor.type === "party") || !item.isOwner) return false;
  return ((item.system.quantity ?? 0) > 0) && (getDepositParties(actor).length > 0);
}

/* -------------------------------------------------- */

/**
 * Move some quantity of a treasure from a hero into their party's stash.
 * @param {Item} item                     A treasure owned by a party member.
 * @param {object} [options]
 * @param {Actor} [options.party]         Skip the prompt and put it in this party.
 * @param {number} [options.quantity]     Skip the prompt and move this many.
 * @returns {Promise<{ party: Actor, quantity: number }|null>}  What was moved, or null if nothing was.
 */
export async function depositToParty(item, { party, quantity } = {}) {
  const actor = item?.actor;
  if ((item?.type !== "treasure") || !actor || (actor.type === "party") || !item.isOwner) return null;
  const name = item.name;
  const available = item.system.quantity ?? 0;
  if (available <= 0) return null;

  // Removing such a treasure would orphan what it granted; the system's own delete flow has to handle it.
  if (item.hasGrantedItems) {
    ui.notifications.warn("DSPI.Deposit.GrantsItems", { format: { item: name } });
    return null;
  }

  if (!party || !quantity) {
    const targets = party ? [party] : getDepositParties(actor);
    if (!targets.length) {
      ui.notifications.warn("DSPI.Deposit.NoParty", { localize: true });
      return null;
    }
    const choice = await promptTransfer({
      targets,
      available,
      title: game.i18n.format("DSPI.Deposit.Title", { item: name }),
      targetLabel: "DSPI.Deposit.Party",
      availableHint: game.i18n.format("DSPI.Deposit.QuantityHint", { available, actor: actor.name }),
    });
    if (!choice) return null;
    party = choice.target;
    quantity ??= choice.quantity;
  }

  if ((party?.type !== "party") || !party.isOwner) return null;
  const moved = await moveTreasure(item, party, quantity);
  if (!moved) return null;

  await recordTransfer(party, { direction: "deposit", actor: actor.name, item: name, quantity: moved });
  ui.notifications.info("DSPI.Deposit.Done", { format: { actor: actor.name, quantity: moved, item: name, party: party.name } });

  return { party, quantity: moved };
}

/* -------------------------------------------------- */
/*   Hero sheet button                                */
/* -------------------------------------------------- */

/**
 * Add a "put in party inventory" button to each treasure row of a hero sheet's Equipment tab.
 * Runs on every render of the sheet; rows that already have the button are skipped.
 * @param {foundry.applications.api.ApplicationV2} app   The hero sheet.
 * @param {HTMLElement} element                          The sheet's element.
 */
export function addDepositButtons(app, element) {
  const actor = app.document;
  if (!actor?.isOwner || !getDepositParties(actor).length) return;

  const rows = element.querySelectorAll("[data-application-part=\"equipment\"] li.item.treasure[data-document-uuid]");
  for (const row of rows) {
    const controls = row.querySelector(".item-controls");
    if (!controls || controls.querySelector(".dspi-deposit")) continue;

    const button = document.createElement("a");
    button.className = "dspi-deposit fa-fw fa-solid fa-hand-holding-hand";
    button.dataset.tooltip = "DSPI.Deposit.Label";
    button.setAttribute("aria-label", game.i18n.localize("DSPI.Deposit.Label"));
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const item = app._getEmbeddedDocument?.(row) ?? await fromUuid(row.dataset.documentUuid);
      if (item) await depositToParty(item);
    });
    controls.prepend(button);
  }
}
