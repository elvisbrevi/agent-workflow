import { expect, test } from "bun:test";
import { AZURE_ORGANIZATION_ENV, azureOrganization } from "../src/azure/azure-organization.ts";
import { SAG_NORMS_REPOSITORY_ENV, sagNormsRepository } from "../src/sag/sag-norms-service.ts";

test("la organizacion Azure viene de LAZY_WORKFLOW_AZURE_ORGANIZATION", () => {
  expect(azureOrganization({ [AZURE_ORGANIZATION_ENV]: "https://dev.azure.com/acme/" }))
    .toBe("https://dev.azure.com/acme");
});

test("sin LAZY_WORKFLOW_AZURE_ORGANIZATION la corrida falla nombrando la variable", () => {
  expect(() => azureOrganization({})).toThrow(AZURE_ORGANIZATION_ENV);
});

test("el repositorio de normas SAG viene de LAZY_WORKFLOW_SAG_NORMS_REPOSITORY", () => {
  expect(sagNormsRepository({ [SAG_NORMS_REPOSITORY_ENV]: "https://dev.azure.com/acme/Team/_git/norms/" }))
    .toBe("https://dev.azure.com/acme/Team/_git/norms");
});

test("sin LAZY_WORKFLOW_SAG_NORMS_REPOSITORY la corrida falla nombrando la variable", () => {
  expect(() => sagNormsRepository({})).toThrow(SAG_NORMS_REPOSITORY_ENV);
});
