import { createPayment } from "../../src/payments/createPayment.js";

test("creates a payment", async () => {
  await createPayment({ body: { amount: 100, currency: "USD" }, headers: {} }, fakeDb());
});

function fakeDb() {
  return {
    payments: {
      create: async (payment) => payment
    }
  };
}
