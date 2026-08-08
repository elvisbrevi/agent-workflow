import { $ } from "bun";

const output = await $`ls -l`.text();
console.log(output);
