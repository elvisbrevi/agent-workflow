/**
 * Los tests que ejercitan Azure o las normas SAG sin declarar un origen propio
 * corren contra URLs de fixture, aunque el operador tenga URLs reales en su
 * entorno. Los defaults de produccion siguen exigiendo ambas variables.
 */
process.env["LAZY_WORKFLOW_AZURE_ORGANIZATION"] = "https://dev.azure.com/org";
process.env["LAZY_WORKFLOW_SAG_NORMS_REPOSITORY"] = "https://dev.azure.com/org/Team/_git/norms";
