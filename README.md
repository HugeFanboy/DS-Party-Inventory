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

Only treasures, projects and followers can be stored on a party. Other item types are refused with a warning.

## Projects tab

- Drag a project in, or drag a treasure or an imbuement effect onto the tab to start crafting it.
- Click a project's name to roll. You choose which of your heroes in the party is doing the work; the roll uses that hero's characteristics and skills, the chat message is posted as that hero, and the points are added to the party's project. If you only own one hero and it has no followers, the choice is skipped.
- A hero's own followers appear in the same list, so a player's artisan or sage can contribute.
- Followers kept by the party itself are listed underneath (shown in Edit mode, or whenever there is at least one). Click one to roll it on a party project.
- Right-click a project for **Spend Career Points** (takes them from a hero you own) and **Draw Event**.
- Breakthrough rolls from the chat card ask for the roller again.
- When a crafting project is completed, the item it yields goes into the party inventory.

## How it works

The module registers a sheet class that extends the system's party sheet and makes it the default for party actors. The original sheet stays available under **Configure Sheet**.

It also wraps `ProjectModel#rollPrompt` so that a project owned by a party reads its characteristic and skills from the chosen hero. Projects owned by heroes are not affected.

A small API is exposed at `game.modules.get("ds-party-inventory").api`:

```js
const api = game.modules.get("ds-party-inventory").api;
api.rollPartyProject(project);                  // prompts for the roller
api.rollPartyProject(project, { roller: hero }); // rolls as a specific hero or follower item
api.giveToMember(treasure);                      // prompts for recipient and quantity
api.giveToMember(treasure, { recipient: hero, quantity: 2 });
```

## Releasing

Publish a GitHub release whose tag is the version number, with or without a leading `v` (for example `v0.1.0`). The release workflow stamps that version into `module.json`, points its download URL at that release, and attaches `module.json` and `module.zip` to it.
