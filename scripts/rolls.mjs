import { MODULE_ID } from "./constants.mjs";

/**
 * The heroes the current user may roll with for a party: members of the party that the user owns.
 * A user with no such hero falls back to their assigned character, if it is a hero.
 * @param {Actor} party   A party actor.
 * @returns {Actor[]}     Heroes sorted by name.
 */
export function getPartyHeroes(party) {
  const heroes = [];
  for (const member of party?.system?.members ?? []) {
    const actor = member?.actor;
    if ((actor?.type === "hero") && actor.isOwner) heroes.push(actor);
  }
  if (!heroes.length && (game.user.character?.type === "hero")) heroes.push(game.user.character);
  return heroes.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
}

/* -------------------------------------------------- */

/**
 * Ask the user which of their heroes (or those heroes' followers) is making a project roll.
 * Skips the dialog when there is only one possibility.
 * @param {Actor} party               The party that owns the project.
 * @param {object} [options]
 * @param {string} [options.title]    Dialog title.
 * @returns {Promise<Actor|Item|null>}  A hero actor, a follower item, or null if nobody was chosen.
 */
export async function chooseRoller(party, { title } = {}) {
  const heroes = getPartyHeroes(party);
  if (!heroes.length) {
    ui.notifications.warn("DSPI.Roller.None", { localize: true });
    return null;
  }

  const heroGroup = game.i18n.localize("DSPI.Roller.Heroes");
  const followerGroup = game.i18n.localize("DSPI.Roller.Followers");
  const options = heroes.map(hero => ({ value: hero.uuid, label: hero.name, group: heroGroup }));
  for (const hero of heroes) {
    for (const follower of hero.itemTypes?.follower ?? []) {
      options.push({
        value: follower.uuid,
        label: game.i18n.format("DSPI.Roller.FollowerOf", { follower: follower.name, hero: hero.name }),
        group: followerGroup,
      });
    }
  }

  if (options.length === 1) return heroes[0];

  const preferred = game.user.character?.uuid;
  const value = options.some(o => o.value === preferred) ? preferred : options[0].value;
  for (const option of options) option.selected = option.value === value;

  const { createFormGroup, createSelectInput } = foundry.applications.fields;
  const content = document.createElement("div");
  content.append(createFormGroup({
    label: "DSPI.Roller.Label",
    hint: "DSPI.Roller.Hint",
    localize: true,
    input: createSelectInput({ name: "roller", options, value }),
  }));

  const fd = await ds.applications.api.DSDialog.input({
    content,
    window: { title: title ?? "DSPI.Roller.Label", icon: "fa-solid fa-users" },
  });
  if (!fd?.roller) return null;

  return fromUuid(fd.roller);
}

/* -------------------------------------------------- */

/**
 * Roll a party-owned project as one of the user's heroes or followers.
 * Points are added to the party's project; the chat message speaks as the hero.
 * @param {Item} project                  A project item owned by a party.
 * @param {object} [options]
 * @param {Actor|Item} [options.roller]   Skip the prompt and roll as this hero actor or follower item.
 * @returns {Promise<ChatMessage|null>}
 */
export async function rollPartyProject(project, { roller } = {}) {
  roller ??= await chooseRoller(project.actor, {
    title: game.i18n.format("DSPI.Roller.Title", { project: project.name }),
  });
  if (!roller) return null;

  // Followers are handled natively by the system.
  if (roller.documentName === "Item") return project.system.roll({ follower: roller });

  const speaker = getDocumentClass("ChatMessage").getSpeaker({ actor: roller });
  return project.system.roll({ partyRoller: roller }, {}, { data: { speaker } });
}

/* -------------------------------------------------- */

/**
 * The system's ProjectModel#rollPrompt, but reading characteristics, skills and roll data from a chosen hero
 * instead of the project's owner (a party has none of those).
 * @param {object} model    The project's system data model.
 * @param {Actor} hero      The hero making the roll.
 * @param {object} config   Roll configuration, as passed to ProjectModel#rollPrompt.
 * @param {object} dialogOptions  Options forwarded to the roll dialog.
 * @returns {Promise<{ projectRoll: Roll, messageMode: string }|null>}
 */
async function heroRollPrompt(model, hero, config, dialogOptions) {
  const { ProjectRoll } = ds.rolls;
  const rollData = hero.getRollData();

  // Pick the hero's highest characteristic amongst the project's roll characteristics
  let chr = null;
  const characteristicData = hero.system.characteristics ?? {};
  for (const characteristic of model.rollCharacteristic) {
    if (chr === null) chr = characteristic;
    else if ((characteristicData[characteristic]?.value ?? -Infinity) > (characteristicData[chr]?.value ?? -Infinity)) chr = characteristic;
  }

  const rollKey = ds.CONFIG.characteristics[chr]?.rollKey ?? "";
  const formula = rollKey ? `2d10 + @${rollKey}` : "2d10";

  const dialogConfig = foundry.utils.mergeObject({
    context: {
      modifiers: config.modifiers ?? {},
      formula: ProjectRoll.replaceFormulaData(formula, rollData, { missing: "0" }),
      skills: hero.system.skills?.value ?? null,
      skillModifiers: hero.system.skills?.modifiers ?? null,
    },
    window: {
      title: `${model.parent.name}: ${hero.name}`,
    },
  }, dialogOptions);

  const fd = await ds.applications.apps.PowerRollDialog.create(dialogConfig);
  if (!fd) return null;

  const projectRoll = new ProjectRoll(formula, rollData, {
    flavor: config.flavor ?? game.i18n.localize("DRAW_STEEL.ROLL.Project.Label"),
    ...fd.rolls[0],
  });

  await projectRoll.evaluate();

  return { projectRoll, messageMode: fd.messageMode };
}

/* -------------------------------------------------- */

/**
 * Wrap the system's ProjectModel#rollPrompt so that projects owned by a party roll with a hero.
 * This covers both the sheet button and the "Roll Breakthrough" button on project chat messages.
 * Projects owned by anything other than a party are untouched.
 */
export function patchProjectRollPrompt() {
  const ProjectModel = CONFIG.Item.dataModels?.project;
  const original = ProjectModel?.prototype?.rollPrompt;
  if (typeof original !== "function") {
    console.error(`${MODULE_ID} | Could not find the Draw Steel project data model; party project rolls are unavailable.`);
    return;
  }
  if (original._dsPartyInventory) return;

  async function rollPrompt(config = {}, dialogOptions = {}) {
    if ((this.actor?.type !== "party") || config.follower) return original.call(this, config, dialogOptions);

    const roller = config.partyRoller ?? await chooseRoller(this.actor, {
      title: game.i18n.format("DSPI.Roller.Title", { project: this.parent.name }),
    });
    if (!roller) return null;
    if (roller.documentName === "Item") return original.call(this, { ...config, follower: roller }, dialogOptions);
    return heroRollPrompt(this, roller, config, dialogOptions);
  }
  rollPrompt._dsPartyInventory = true;

  ProjectModel.prototype.rollPrompt = rollPrompt;
}

/* -------------------------------------------------- */

/**
 * The heroes who could spend career project points on a party project.
 * @param {Item} project
 * @returns {{ hero: Actor, points: number }[]}
 */
export function getCareerPointSpenders(project) {
  if ((project?.type !== "project") || (project.actor?.type !== "party")) return [];
  const pointsToCompletion = Math.max(0, (project.system.goal ?? 0) - project.system.points);
  if (!pointsToCompletion) return [];

  return getPartyHeroes(project.actor).reduce((arr, hero) => {
    const points = hero.system.career?.system?.projectPoints ?? 0;
    if (points > 0) arr.push({ hero, points });
    return arr;
  }, []);
}

/* -------------------------------------------------- */

/**
 * Spend one hero's career project points on a party project.
 * Mirrors the system's ProjectModel#spendCareerPoints, which only works when the hero owns the project.
 * @param {Item} project    A project item owned by a party.
 * @returns {Promise<void>}
 */
export async function spendPartyCareerPoints(project) {
  const spenders = getCareerPointSpenders(project);
  if (!spenders.length) return;

  const { createFormGroup, createSelectInput } = foundry.applications.fields;
  let spender = spenders[0];

  if (spenders.length > 1) {
    const content = document.createElement("div");
    content.append(createFormGroup({
      label: "DSPI.CareerPoints.HeroLabel",
      hint: "DSPI.CareerPoints.HeroHint",
      localize: true,
      input: createSelectInput({
        name: "hero",
        options: spenders.map(({ hero, points }) => ({
          value: hero.id,
          label: game.i18n.format("DSPI.CareerPoints.HeroOption", { hero: hero.name, points }),
        })),
      }),
    }));
    const choice = await ds.applications.api.DSDialog.input({
      content,
      window: { title: "DRAW_STEEL.Item.project.SpendCareerPoints.Title", icon: "fa-solid fa-hammer" },
    });
    if (!choice?.hero) return;
    spender = spenders.find(s => s.hero.id === choice.hero);
    if (!spender) return;
  }

  const { hero, points: careerPoints } = spender;
  const pointsToCompletion = Math.max(0, project.system.goal - project.system.points);

  const input = foundry.applications.elements.HTMLRangePickerElement.create({
    min: 0,
    name: "spendPoints",
    max: Math.min(careerPoints, pointsToCompletion),
    step: 1,
  });
  const content = document.createElement("div");
  content.append(createFormGroup({
    input,
    classes: ["stacked"],
    label: "DRAW_STEEL.Item.project.SpendCareerPoints.Label",
    localize: true,
  }));

  const fd = await ds.applications.api.DSDialog.input({
    content,
    window: { title: "DRAW_STEEL.Item.project.SpendCareerPoints.Title", icon: "fa-solid fa-hammer" },
  });
  const spend = Number(fd?.spendPoints) || 0;
  if (spend <= 0) return;

  await project.update({ "system.points": project.system.points + spend });
  await hero.system.career.update({ "system.projectPoints": careerPoints - spend });

  ui.notifications.success("DRAW_STEEL.Item.project.SpendCareerPoints.Success", {
    format: { actor: hero.name, points: spend, project: project.name },
  });
}
