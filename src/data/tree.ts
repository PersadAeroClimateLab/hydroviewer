import type { Catalog, Node, Run } from './catalog';

// The rules of the data tree (docs/llm/DATA_TREE_PLAN.md), with no DOM: three columns, scenarios › models › members,
// what each shows, which items are dark or fixed, the links between them and what a hover or click does. The pane
// only draws what this says. Pure functions of a `TreeState`, so the pane keeps the state and tests need no page.
//
// The selection is always a node the globe can show: a scenario's multi-model mean, a model's ensemble or one
// member. Hovering a scenario previews its models, hovering a model its members; a click picks, and also fixes
// the hovered items it hangs from. A click on the picked model or member releases it (up one level); a scenario
// cannot be released. Picking another scenario keeps the model and member where that scenario has them, so
// scenarios can be compared. A member without maps can be picked: the globe then shows its ensemble.

export const ALL = '*'; // the aggregate item of a column: all models, or the whole ensemble

export interface Selection {
  scenario: string;
  model?: string; // none: all models
  member?: string; // none: the ensemble
}

export interface TreeState {
  selection: Selection;
  hover: { scenario?: string; model?: string }; // model may be ALL
}

// `on` is dark (in play), `fixed` is on the selection's path (bold). `count`: models of a scenario, members of a
// model or aggregate. `maps`: whether a member has map stores (false: drawn hollow).
export interface Item {
  id: string;
  label: string;
  count?: number;
  on: boolean;
  fixed: boolean;
  maps?: boolean;
}

// From an item of column `level` to one of column `level + 1`. `fixed`: on the selection's path (dark), else a
// preview (grey). `weight`: how many runs the link stands for (a bundle to an aggregate item).
export interface Link {
  level: 0 | 1;
  from: string;
  to: string;
  fixed: boolean;
  weight: number;
}

type Tree = Pick<Catalog, 'scenarios' | 'runs'>;

const byNumber = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
// A selection with only the levels it has (no `model: undefined`), so equal selections compare equal.
const at = (scenario: string, model?: string, member?: string): Selection => ({
  scenario,
  ...(model && { model }),
  ...(model && member && { member }),
});

export function createTree(catalog: Tree) {
  const runs = new Map(catalog.runs.map((r) => [`${r.scenario}/${r.model}`, r]));
  const run = (scenario: string, model?: string): Run | undefined => (model ? runs.get(`${scenario}/${model}`) : undefined);
  // A scenario's runs, largest ensembles first (D5).
  const models = (scenario: string) =>
    catalog.runs.filter((r) => r.scenario === scenario).sort((a, b) => b.members.length - a.members.length || byNumber(a.model, b.model));
  const label = (scenario: string) => catalog.scenarios.find((s) => s.id === scenario)?.label ?? scenario;

  // What the columns show: the hovered item, else the selection's; a model only where the scenario has it.
  const activeScenario = (st: TreeState) => st.hover.scenario ?? st.selection.scenario;
  const activeModel = (st: TreeState) => {
    const model = st.hover.model ?? st.selection.model ?? ALL;
    return model !== ALL && run(activeScenario(st), model) ? model : ALL;
  };
  // The selected member, if the active run is the selection's.
  const selectedMember = (st: TreeState) =>
    activeScenario(st) === st.selection.scenario && activeModel(st) === st.selection.model ? st.selection.member : undefined;

  return {
    // SSP2-4.5's multi-model mean if there is one, else the first scenario's.
    initial(): TreeState {
      const scenario = (catalog.scenarios.find((s) => s.id === 'ssp245') ?? catalog.scenarios[0]).id;
      return { selection: { scenario }, hover: {} };
    },

    // The node to open: a member only if it has maps, else its ensemble.
    node({ selection: { scenario, model, member } }: TreeState): Node {
      return member && run(scenario, model)?.maps.includes(member) ? at(scenario, model, member) : at(scenario, model);
    },

    // The selection as labels, for the closed pane: e.g. ["SSP2-4.5", "CanESM5", "Ensemble (50)"].
    path({ selection: { scenario, model, member } }: TreeState): string[] {
      const r = run(scenario, model);
      if (!r) return [label(scenario), `All models (${models(scenario).length})`];
      if (!member) return [label(scenario), r.model, `Ensemble (${r.members.length})`];
      return [label(scenario), r.model, r.maps.includes(member) ? member : `${member} (no maps)`];
    },

    items(st: TreeState, column: 0 | 1 | 2): Item[] {
      const scenario = activeScenario(st);
      const atSelection = scenario === st.selection.scenario;
      if (column === 0) {
        return catalog.scenarios.map((s) => ({
          id: s.id,
          label: s.label,
          count: models(s.id).length,
          on: s.id === scenario,
          fixed: s.id === st.selection.scenario,
        }));
      }
      const model = activeModel(st);
      if (column === 1) {
        const fixed = atSelection ? (st.selection.model ?? ALL) : undefined;
        const list = models(scenario);
        return [
          { id: ALL, label: 'All models', count: list.length, on: model === ALL, fixed: fixed === ALL },
          ...list.map((r) => ({ id: r.model, label: r.model, count: r.members.length, on: r.model === model, fixed: r.model === fixed })),
        ];
      }
      const r = run(scenario, model);
      if (!r) return [];
      const member = selectedMember(st);
      const atRun = atSelection && model === st.selection.model;
      return [
        { id: ALL, label: 'Ensemble', count: r.members.length, on: !member, fixed: atRun && !member },
        ...r.members.map((id) => ({ id, label: id, on: !member || id === member, fixed: atRun && id === member, maps: r.maps.includes(id) })),
      ];
    },

    // At most one link per level for what the columns show, plus the selection's own model link when a hovered
    // model in the same scenario differs from it. With 50 models and 70 members, one curve per item would not fit.
    links(st: TreeState): Link[] {
      const scenario = activeScenario(st);
      const model = activeModel(st);
      const atSelection = scenario === st.selection.scenario;
      const fixedModel = atSelection ? (st.selection.model ?? ALL) : undefined;
      const weight = (m: string) => (m === ALL ? models(scenario).length : 1);
      const links: Link[] = [{ level: 0, from: scenario, to: model, fixed: model === fixedModel, weight: weight(model) }];
      if (fixedModel !== undefined && fixedModel !== model) links.push({ level: 0, from: scenario, to: fixedModel, fixed: true, weight: weight(fixedModel) });
      const r = run(scenario, model);
      if (r) {
        const member = selectedMember(st);
        links.push({ level: 1, from: model, to: member ?? ALL, fixed: model === fixedModel, weight: member ? 1 : r.members.length });
      }
      return links;
    },

    hover(st: TreeState, column: 0 | 1, id: string): TreeState {
      if (column === 0) return { ...st, hover: { scenario: id } };
      return { ...st, hover: { scenario: st.hover.scenario, model: id } };
    },

    // Leaving the pane drops the hover, not the selection.
    leave(st: TreeState): TreeState {
      return { ...st, hover: {} };
    },

    // A click: picks the item (or releases it, see the top), fixing the hovered items it hangs from. An item that is
    // not shown changes nothing. The hover is dropped, so nothing older is previewed afterwards.
    pick(st: TreeState, column: 0 | 1 | 2, id: string): TreeState {
      const sel = st.selection;
      const done = (selection: Selection): TreeState => ({ selection, hover: {} });
      if (column === 0) {
        if (!catalog.scenarios.some((s) => s.id === id)) return st;
        const r = run(id, sel.model);
        if (!r) return done(at(id));
        return done(at(id, r.model, sel.member && r.members.includes(sel.member) ? sel.member : undefined));
      }
      const scenario = activeScenario(st);
      if (column === 1) {
        if (id === ALL || (scenario === sel.scenario && id === sel.model && !sel.member)) return done(at(scenario));
        return run(scenario, id) ? done(at(scenario, id)) : st;
      }
      const model = activeModel(st);
      const r = run(scenario, model);
      if (!r) return st;
      if (id === ALL || id === selectedMember(st)) return done(at(scenario, model));
      return r.members.includes(id) ? done(at(scenario, model, id)) : st;
    },
  };
}
