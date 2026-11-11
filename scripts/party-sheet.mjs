import { MODULE_ID, PARTY_ITEM_TYPES, TAB_INVENTORY, TAB_PROJECTS, modulePath } from "./constants.mjs";
import { getCareerPointSpenders, rollPartyProject, spendPartyCareerPoints } from "./rolls.mjs";
import { canGive, getRecipients, giveToMember } from "./transfer.mjs";
import { createCraftingProject, craftingProjectData } from "./crafting.mjs";

/**
 * Build the party sheet class. This has to happen after the Draw Steel system has loaded,
 * so the class is created on demand instead of at import time.
 * @returns {typeof foundry.applications.api.DocumentSheet|null}
 */
export default function createPartyInventorySheet() {
  const Base = globalThis.ds?.applications?.sheets?.DrawSteelPartySheet;
  if (!Base) {
    console.error(`${MODULE_ID} | The Draw Steel party sheet was not found; the module is inactive.`);
    return null;
  }

  const accessPartial = modulePath("templates/access-notice.hbs");

  /**
   * The Draw Steel party sheet with a shared Inventory tab and a shared Projects tab.
   */
  return class DSPartyInventorySheet extends Base {
    /** @inheritdoc */
    static DEFAULT_OPTIONS = {
      classes: ["ds-party-inventory"],
      actions: {
        modifyItemQuantity: this.#modifyItemQuantity,
        giveToMember: this.#giveToMember,
        rollPartyProject: this.#rollPartyProject,
        shareWithPlayers: this.#shareWithPlayers,
      },
    };

    /* -------------------------------------------------- */

    /** @inheritdoc */
    static PARTS = (() => {
      const { details, ...parts } = Base.PARTS;
      parts[TAB_INVENTORY] = {
        template: modulePath("templates/inventory.hbs"),
        templates: [accessPartial],
        classes: ["tab"],
        scrollable: [".contents"],
      };
      parts[TAB_PROJECTS] = {
        template: modulePath("templates/projects.hbs"),
        templates: [accessPartial],
        classes: ["tab"],
        scrollable: [".contents"],
      };
      if (details) parts.details = details;
      return parts;
    })();

    /* -------------------------------------------------- */

    /** @inheritdoc */
    static TABS = (() => {
      const primary = Base.TABS.primary;
      const tabs = primary.tabs.map(tab => ({ ...tab }));
      const index = tabs.findIndex(tab => tab.id === "details");
      tabs.splice(index < 0 ? tabs.length : index, 0, { id: TAB_INVENTORY }, { id: TAB_PROJECTS });
      return { ...Base.TABS, primary: { ...primary, tabs } };
    })();

    /* -------------------------------------------------- */
    /*   Context                                          */
    /* -------------------------------------------------- */

    /** @inheritdoc */
    async _preparePartContext(partId, context, options) {
      context = (await super._preparePartContext(partId, context, options)) ?? context;
      const models = CONFIG.Item.dataModels;

      switch (partId) {
        case TAB_INVENTORY:
          context.access = this.#prepareAccess();
          context.treasure = await this.#prepareTreasureContext();
          context.treasureFields = models.treasure.schema.fields;
          context.hasTreasure = this.actor.itemTypes.treasure.length > 0;
          context.canGive = this.document.isOwner && (getRecipients(this.document).length > 0);
          break;
        case TAB_PROJECTS:
          context.access = this.#prepareAccess();
          context.projects = await this.#prepareItemsContext("project");
          context.projectFields = models.project.schema.fields;
          context.canRoll = this.document.isOwner;
          break;
      }

      return context;
    }

    /* -------------------------------------------------- */

    /**
     * What the current user is allowed to do, and whether the Director should be nudged to share the party.
     * @returns {{ isOwner: boolean, canShare: boolean }}
     */
    #prepareAccess() {
      const party = this.document;
      const canShare = game.user.isGM && !party.inCompendium
        && game.users.some(user => !user.isGM && !party.testUserPermission(user, "OWNER"));
      return { isOwner: party.isOwner, canShare };
    }

    /* -------------------------------------------------- */

    /**
     * Prepare the context for one item type, in sheet order.
     * @param {string} type   An item type.
     * @returns {Promise<object[]>}
     */
    async #prepareItemsContext(type) {
      const items = this.actor.itemTypes[type].toSorted((a, b) => a.sort - b.sort);
      const context = [];
      for (const item of items) context.push(await this._prepareItemContext(item));
      return context;
    }

    /* -------------------------------------------------- */

    /**
     * Prepare treasure grouped by category, the same way the hero sheet's Equipment tab does.
     * @returns {Promise<Record<string, { label: string, treasure: object[], showAdd: boolean, showHeader: boolean }>>}
     */
    async #prepareTreasureContext() {
      const context = {};
      const treasures = this.actor.itemTypes.treasure.toSorted((a, b) => a.sort - b.sort);

      for (const [category, config] of Object.entries(ds.CONFIG.equipment.categories)) {
        context[category] = {
          label: config.label,
          treasure: [],
          showAdd: this.isEditMode,
          showHeader: this.isEditMode,
        };
      }

      // Added last so that uncategorised treasure sits at the bottom
      context.other = {
        label: game.i18n.localize("DRAW_STEEL.SHEET.Other"),
        treasure: [],
        showAdd: false,
        showHeader: false,
      };

      for (const item of treasures) {
        const category = context[item.system.category] ? item.system.category : "other";
        context[category].showHeader = true;
        context[category].treasure.push(await this._prepareItemContext(item));
      }

      if (this.isPlayMode) {
        for (const [key, value] of Object.entries(context)) {
          if (!value.treasure.length) delete context[key];
        }
      }

      return context;
    }

    /* -------------------------------------------------- */
    /*   Context Menu                                     */
    /* -------------------------------------------------- */

    /** @inheritdoc */
    _getDocumentListContextOptions() {
      const options = super._getDocumentListContextOptions();

      // The system's own entry needs the project's owner to have a career, which a party never does.
      const careerPoints = {
        label: "DRAW_STEEL.Item.project.SpendCareerPoints.Title",
        icon: "fa-solid fa-hammer",
        visible: (target) => {
          if (!this.document.isOwner) return false;
          return getCareerPointSpenders(this._getEmbeddedDocument(target)).length > 0;
        },
        onClick: async (event, target) => {
          await spendPartyCareerPoints(this._getEmbeddedDocument(target));
          await this.render();
        },
      };

      const giveToMemberEntry = {
        label: "DSPI.Give.Label",
        icon: "fa-solid fa-hand-holding-hand",
        visible: (target) => canGive(this._getEmbeddedDocument(target)),
        onClick: async (event, target) => {
          await giveToMember(this._getEmbeddedDocument(target));
        },
      };

      // Start crafting through this module, so the project keeps a copy of the treasure it will produce.
      const craft = options.find(o => o.label === "DRAW_STEEL.Item.project.Craft.FromTreasure.Label");
      if (craft) {
        craft.onClick = async (event, target) => {
          const item = this._getEmbeddedDocument(target);
          const project = await createCraftingProject(this.actor, item);
          if (project) ui.notifications.success("DRAW_STEEL.Item.project.Craft.FromTreasure.Notification", { format: { item: item.name } });
        };
      }

      const index = options.findIndex(o => o.label === "DRAW_STEEL.Item.project.Events.DrawEvent");
      options.splice(index < 0 ? 0 : index, 0, careerPoints);
      options.unshift(giveToMemberEntry);
      return options;
    }

    /* -------------------------------------------------- */
    /*   Actions                                          */
    /* -------------------------------------------------- */

    /**
     * Raise or lower the quantity of a treasure.
     * @this DSPartyInventorySheet
     * @param {PointerEvent} event   The originating click event.
     * @param {HTMLElement} target   The capturing HTML element which defined a [data-action].
     */
    static async #modifyItemQuantity(event, target) {
      const item = this._getEmbeddedDocument(target);
      if (!item?.isOwner) return;

      const quantity = item.system.quantity ?? 0;
      const delta = (target.dataset.quantityModification === "increase") ? 1 : -1;
      const updated = Math.max(0, quantity + delta);
      if (updated !== quantity) await item.update({ "system.quantity": updated });
    }

    /* -------------------------------------------------- */

    /**
     * Hand a treasure from the stash to a party member.
     * @this DSPartyInventorySheet
     * @param {PointerEvent} event   The originating click event.
     * @param {HTMLElement} target   The capturing HTML element which defined a [data-action].
     */
    static async #giveToMember(event, target) {
      await giveToMember(this._getEmbeddedDocument(target));
    }

    /* -------------------------------------------------- */

    /**
     * Roll a party project as one of the user's heroes.
     * @this DSPartyInventorySheet
     * @param {PointerEvent} event   The originating click event.
     * @param {HTMLElement} target   The capturing HTML element which defined a [data-action].
     */
    static async #rollPartyProject(event, target) {
      const project = this._getEmbeddedDocument(target);
      if (project?.type !== "project") return;
      await rollPartyProject(project);
    }

    /* -------------------------------------------------- */

    /**
     * Give every player ownership of the party, after confirmation.
     * @this DSPartyInventorySheet
     * @param {PointerEvent} event   The originating click event.
     * @param {HTMLElement} target   The capturing HTML element which defined a [data-action].
     */
    static async #shareWithPlayers(event, target) {
      if (!game.user.isGM) return;
      const name = this.document.name;

      const confirmed = await ds.applications.api.DSDialog.confirm({
        window: { title: "DSPI.Access.ShareTitle", icon: "fa-solid fa-users" },
        content: `<p>${game.i18n.format("DSPI.Access.ShareConfirm", { name: foundry.utils.escapeHTML(name) })}</p>`,
        rejectClose: false,
      });
      if (!confirmed) return;

      // Raise the default and clear any per-player level that would still hold someone below Owner.
      const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
      const ownership = { default: OWNER };
      for (const user of game.users) {
        if (user.isGM) continue;
        const level = this.document.ownership[user.id];
        if ((level !== undefined) && (level < OWNER)) ownership[user.id] = OWNER;
      }
      await this.document.update({ ownership });
      ui.notifications.info("DSPI.Access.Shared", { format: { name } });
    }

    /* -------------------------------------------------- */
    /*   Drag and Drop                                    */
    /* -------------------------------------------------- */

    /**
     * Was something dropped onto the Projects tab?
     * @param {DragEvent} event
     * @returns {boolean}
     */
    #isProjectDrop(event) {
      return !!event.target.closest(`[data-application-part="${TAB_PROJECTS}"]`);
    }

    /* -------------------------------------------------- */

    /**
     * Run an operation that adds an item, bringing the tab that item lives on to the front.
     * @param {string} tab                  The tab to show.
     * @param {() => Promise<any>} create   The operation.
     * @returns {Promise<any>}
     */
    async #createOnTab(tab, create) {
      const previous = this.tabGroups.primary;
      this.tabGroups.primary = tab;
      let result;
      try {
        result = await create();
      } finally {
        if (!result) this.tabGroups.primary = previous;
      }
      return result;
    }

    /* -------------------------------------------------- */

    /** @inheritdoc */
    async _onDropItem(event, item) {
      if (!this.isEditable) return null;
      if (this.actor.uuid === item.parent?.uuid) {
        const result = await this._onSortItem(event, item);
        return result?.length ? item : null;
      }

      // A treasure dropped on the Projects tab becomes a crafting project, as on the hero sheet
      if (this.#isProjectDrop(event) && (item.type === "treasure")) {
        return (await this.#createOnTab(TAB_PROJECTS, () => createCraftingProject(this.actor, item))) ?? null;
      }

      if (!PARTY_ITEM_TYPES.has(item.type)) {
        ui.notifications.warn("DSPI.Drop.InvalidType", {
          format: { type: game.i18n.localize(CONFIG.Item.typeLabels[item.type] ?? item.type) },
        });
        return null;
      }

      const tab = (item.type === "treasure") ? TAB_INVENTORY : TAB_PROJECTS;
      const keepId = !this.actor.items.has(item.id);
      const itemData = game.items.fromCompendium(item, { keepId, clearFolder: true });
      const result = await this.#createOnTab(tab, () => getDocumentClass("Item").create(itemData, { parent: this.actor, keepId }));
      return result ?? null;
    }

    /* -------------------------------------------------- */

    /** @inheritdoc */
    async _onDropFolder(event, folder) {
      if (!this.isEditable) return null;
      if (folder.type !== "Item") return null;
      const projectDrop = this.#isProjectDrop(event);

      const itemData = await Promise.all(folder.contents.map(async (item) => {
        if (!(item instanceof foundry.documents.Item)) item = await fromUuid(item.uuid);
        if (!item) return null;

        if (projectDrop && (item.type === "treasure")) {
          return craftingProjectData(item);
        }
        if (!PARTY_ITEM_TYPES.has(item.type)) return null;

        const keepId = !this.actor.items.has(item.id);
        return game.items.fromCompendium(item, { keepId, clearFolder: true });
      }));

      const toCreate = itemData.filter(_ => _);
      if (!toCreate.length) return null;
      await this.actor.createEmbeddedDocuments("Item", toCreate, { keepId: true });
      return folder;
    }

    /* -------------------------------------------------- */

    /** @inheritdoc */
    async _onDropActiveEffect(event, effect) {
      if (!this.isEditable || !effect) return null;

      // An imbuement dropped on the Projects tab becomes a crafting project. Parties cannot hold effects otherwise.
      if (this.#isProjectDrop(event) && effect.system?.project) {
        return (await this.#createOnTab(TAB_PROJECTS, () => createCraftingProject(this.actor, effect))) ?? null;
      }
      return null;
    }
  };
}
