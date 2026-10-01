import {
  CONTRACT_NOW,
  demoCatalog,
  describeSchedulingProviderContract,
  InMemorySchedulingProvider,
} from "../src/testing";

describeSchedulingProviderContract("em memória", async () => {
  const provider = new InMemorySchedulingProvider(demoCatalog(), () => CONTRACT_NOW);
  return {
    provider,
    services: { corte: "svc-corte", sobrancelha: "svc-sobrancelha" },
    professionals: { carlos: "prof-carlos", marcos: "prof-marcos" },
    customer: { id: "cust-ana", name: "Ana", phoneE164: "+5551999998888" },
  };
});
