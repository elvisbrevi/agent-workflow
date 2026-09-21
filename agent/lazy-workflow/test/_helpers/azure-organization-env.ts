/**
 * Los tests que ejercitan los adaptadores Azure sin declarar una organizacion
 * propia corren contra una organizacion de fixture. El default de produccion
 * exige `LAZY_WORKFLOW_AZURE_ORGANIZATION` y no nombra ninguna real.
 */
process.env["LAZY_WORKFLOW_AZURE_ORGANIZATION"] ??= "https://dev.azure.com/org";
