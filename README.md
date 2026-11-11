# DS-Party-Inventory

A Foundry VTT module for the [Draw Steel](https://github.com/MetaMorphic-Digital/draw-steel) system that adds two tabs to the **party** sheet:

- **Inventory** - a shared stash of treasure, grouped by category like a hero's Equipment tab.
- **Projects** - downtime projects that belong to the whole party. Any player can roll on them with their own hero.

Requires Foundry VTT v14 (built against 14.370) and Draw Steel 1.2.

## Installation

In Foundry's **Install Module** dialog, paste this manifest URL:

```
https://github.com/HugeFanboy/DS-Party-Inventory/releases/latest/download/module.json
```

That URL works once a release has been published (see Releasing). Until then, copy this folder into `Data/modules/` as `ds-party-inventory` (the folder name must match the module id).

Then enable **Draw Steel - Party Inventory & Projects** in your world.

## Giving players access

Players need **Owner** permission on the party actor to add items, change quantities and roll projects. The Director sees a notice on both new tabs with a **Give all players ownership** button while any player is missing it. Players with less than Owner can still read both tabs.

## Inventory tab

- Drag treasure in from a compendium, the Items sidebar or a hero sheet. Folders of treasure work too.
- Use the plus and minus buttons to change a quantity.
- Expand a row to read the treasure, or right-click it for View/Edit, Share to chat, Delete and **Start Crafting Project** (adds a crafting project for that treasure to the Projects tab).
- In Edit mode every category gets a plus button to create a treasure from scratch.
- Click the hand icon (or right-click and choose **Give to Party Member**) to move a treasure to a party member. You pick who gets it and how many; the stash is reduced to match, and consumables and trinkets stack onto a matching item the recipient already has. You can only give to characters you own, so players take items for their own hero and the Director can give to anyone.
- Dragging a treasure from the party sheet onto a hero's sheet still works, but that makes a copy and leaves the stash unchanged.

Only treasures and projects can be stored on a party. Other item types are refused with a warning.

### Putting items in from a hero sheet

Each treasure on a hero's Equipment tab gets a hand button that moves it into the party inventory. It asks how many when the hero has more than one, and which party when the hero belongs to several. The button appears when you own both the hero and a party the hero is a member of.

A treasure that has granted other items to the hero is refused, because removing it needs the system's own delete flow.

### Transfer record

Every move made with a hand button shows a notification to the user who made it and writes a line to that user's browser console (F12), for example `ds-party-inventory | Transfer: Ann received 2 × Healing Potion from The Party's inventory. (by Gamemaster, ...)`. Nothing is stored on the party.

## Projects tab

- Drag a project in, or drag a treasure or an imbuement effect onto the tab to start crafting it.
- Click a project's name to roll. You choose which of your heroes in the party is doing the work; the roll uses that hero's characteristics and skills, the chat message is posted as that hero, and the points are added to the party's project. If you only own one hero and it has no followers, the choice is skipped.
- A hero's own followers appear in the same list, so a player's artisan or sage can contribute. The party itself does not hold followers.
- Right-click a project for **Spend Career Points** (takes them from a hero you own) and **Draw Event**.
- Breakthrough rolls from the chat card ask for the roller again.
- When a crafting project reaches its goal, the item it yields is added to the party inventory automatically. Consumables and trinkets stack onto a matching item; leveled treasures are always added as a new item. The module does this itself instead of relying on the system, and writes what it did to the console. If the item can't be added, you get an error notification saying why.
- A crafting project keeps a copy of the treasure it will produce, so it still completes if the original is later given away or deleted.
- Only projects started from a treasure or imbuement yield an item. Compendium projects such as Build Airship have nothing linked, so completing them adds nothing.

### Carrying over extra points

The world setting **Carry over extra project points** (off by default) applies when a party's crafting project is completed with points to spare. The project starts again with the spare points, and if they are enough to finish it again, it yields again. For example, with a goal of 45 and 100 points, the party gets two batches and the project is left at 10 / 45.

With exactly enough points the project simply stays completed. Projects that don't produce an item or imbuement are never restarted.

## How it works

The module registers a sheet class that extends the system's party sheet and makes it the default for party actors. The original sheet stays available under **Configure Sheet**.

It also wraps two methods of the system's project data model, both only for projects owned by a party: `rollPrompt`, so the roll reads its characteristic and skills from the chosen hero, and `completeCraftingProject`, which is switched off because the module grants the yield itself from the `preUpdateItem` and `updateItem` hooks. Projects owned by heroes are not affected.

The hero-sheet button is added through the `renderDrawSteelHeroSheet` hook.

A small API is exposed at `game.modules.get("ds-party-inventory").api`:

```js
const api = game.modules.get("ds-party-inventory").api;
api.rollPartyProject(project);                  // prompts for the roller
api.rollPartyProject(project, { roller: hero }); // rolls as a specific hero or follower item
api.giveToMember(treasure);                      // prompts for recipient and quantity
api.giveToMember(treasure, { recipient: hero, quantity: 2 });
api.depositToParty(treasure);                    // hero's treasure into their party's inventory
api.createCraftingProject(party, treasure);      // start crafting a treasure or imbuement
```

## Releasing

Publish a GitHub release whose tag is the version number, with or without a leading `v` (for example `v0.1.0`). The release workflow stamps that version into `module.json`, points its download URL at that release, and attaches `module.json` and `module.zip` to it.
