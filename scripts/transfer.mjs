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
 * Find a treasure on the recipient that the given one can be stacked onto.
 * Leveled treasures are never stacked, since each can carry its own imbuements.
 * @param {Item} item         The treasure being given.
 * @param {Actor} recipient   The actor receiving it.
 * @returns {Item|undefined}
 */
function findStack(item, recipient) {
  if (item.system.category === "leveled") return undefined;
  return recipient.items.find(i => (i.type === "treasure") && (i.dsid === item.dsid) && (i.name === item.name));
}

/* -------------------------------------------------- */

/**
 * Move some quantity of a treasure from the party stash to a party member.
 * The recipient is updated first, so an interruption can duplicate an item but never lose one.
 * @param {Item} item                       A treasure owned by a party.
 * @param {object} [options]
 * @param {Actor} [options.recipient]       Skip the prompt and give to this actor.
 * @param {number} [options.quantity]       Skip the prompt and give this many.
 * @returns {Promise<{ recipient: Actor, quantity: number }|null>}  What was given, or null if nothing was.
 */
export async function giveToMember(item, { recipient, quantity } = {}) {
  if ((item?.type !== "treasure") || (item.actor?.type !== "party") || !item.isOwner) return null;
  const available = item.system.quantity ?? 0;
  if (available <= 0) return null;

  if (!recipient || !quantity) {
    const recipients = getRecipients(item.actor);
    if (!recipients.length) {
      ui.notifications.warn("DSPI.Give.NoRecipients", { localize: true });
      return null;
    }

    if ((recipients.length === 1) && (available === 1)) {
      recipient ??= recipients[0];
      quantity ??= 1;
    } else {
      const { createFormGroup, createSelectInput, createNumberInput } = foundry.applications.fields;
      const content = document.createElement("div");
      const preferred = game.user.character?.id;
      const value = recipient?.id ?? (recipients.some(a => a.id === preferred) ? preferred : recipients[0].id);
      content.append(createFormGroup({
        label: "DSPI.Give.Recipient",
        localize: true,
        input: createSelectInput({
          name: "recipient",
          value,
          options: recipients.map(a => ({ value: a.id, label: a.name, selected: a.id === value })),
        }),
      }));
      if (available > 1) {
        content.append(createFormGroup({
          label: "DSPI.Give.Quantity",
          hint: game.i18n.format("DSPI.Give.QuantityHint", { available }),
          localize: true,
          input: createNumberInput({ name: "quantity", value: quantity ?? 1, min: 1, max: available, step: 1 }),
        }));
      }

      const fd = await ds.applications.api.DSDialog.input({
        content,
        window: {
          title: game.i18n.format("DSPI.Give.Title", { item: item.name }),
          icon: "fa-solid fa-hand-holding-hand",
        },
      });
      if (!fd?.recipient) return null;
      recipient = recipients.find(a => a.id === fd.recipient);
      quantity = Number(fd.quantity ?? 1);
    }
  }

  if (!recipient?.isOwner) return null;
  quantity = Math.clamp(Math.floor(Number(quantity) || 0), 0, available);
  if (quantity <= 0) return null;

  // Add to the recipient
  const stack = findStack(item, recipient);
  if (stack) await stack.update({ "system.quantity": (stack.system.quantity ?? 0) + quantity });
  else {
    const itemData = game.items.fromCompendium(item, { clearFolder: true });
    foundry.utils.setProperty(itemData, "system.quantity", quantity);
    const [created] = await recipient.createEmbeddedDocuments("Item", [itemData]);
    if (!created) return null;
  }

  // Remove from the stash
  if (quantity >= available) await item.delete();
  else await item.update({ "system.quantity": available - quantity });

  ui.notifications.info("DSPI.Give.Done", {
    format: { recipient: recipient.name, quantity, item: item.name },
  });

  return { recipient, quantity };
}
