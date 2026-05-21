export async function createPayment(request, db) {
  const payment = await db.payments.create({
    amount: request.body.amount,
    currency: request.body.currency
  });

  return payment;
}
