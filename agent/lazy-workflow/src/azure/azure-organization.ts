/**
 * La organizacion Azure DevOps que usan los adaptadores de este repositorio.
 *
 * El nombre no vive en el codigo publicado: cada operador declara la suya en
 * `LAZY_WORKFLOW_AZURE_ORGANIZATION`, como `LAZY_WORKFLOW_OFF_PASSWORD` ya hace
 * con la contrasena de sudo. Un run que no la declara falla antes de llamar a
 * `az`, en vez de apuntar a una organizacion ajena.
 */
export const AZURE_ORGANIZATION_ENV = "LAZY_WORKFLOW_AZURE_ORGANIZATION";

export function azureOrganization(env: NodeJS.ProcessEnv = process.env): string {
  const organization = env[AZURE_ORGANIZATION_ENV]?.trim();
  if (!organization) {
    throw new Error(
      `Falta ${AZURE_ORGANIZATION_ENV}: exporta la organizacion Azure DevOps del run, ` +
      "por ejemplo https://dev.azure.com/<organizacion>.",
    );
  }
  return organization.replace(/\/+$/, "");
}
