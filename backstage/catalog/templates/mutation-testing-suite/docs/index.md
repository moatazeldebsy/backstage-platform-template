# Mutation Testing Suite (Stryker)

Scaffold a Stryker mutation testing configuration to measure test suite quality beyond code coverage

## How to use

1. Open Backstage → **Create**
2. Find **Mutation Testing Suite (Stryker)** and click **Choose**
3. Fill in the required parameters and click **Create**

## After scaffolding: add code to mutate

Stryker mutates the code **in this repository** and re-runs its tests. A freshly
scaffolded suite has the configuration but no code yet, so CI stays green and
shows a notice, *"Mutation tests skipped: No JavaScript/TypeScript source to
mutate yet"*, until there is some.

Mutation testing belongs next to the code it measures, so **add-to-existing mode**
(which opens a PR on the service repository) is usually the better choice. In
new-repository mode, add your source and its tests, then re-run the workflow.

## Source

Template definition: [`template.yaml`](../template.yaml)
