import { createPayment } from "../payments/createPayment.js";

export async function checkout(request, db) {
  return createPayment(request, db);
}
