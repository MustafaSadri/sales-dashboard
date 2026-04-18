const express = require("express");
const axios = require("axios");
const app = express();

app.set("view engine", "ejs");

// ✅ DIRECT TOKEN (replace with your real token)
// const TOKEN = "9fd5f39b94e6f4bf6a25a253b007488dd801f668";
const TOKEN = process.env.TOKEN;

// helper to get name from meta
async function getName(url) {
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  return res.data.name;
}

// 🔹 PAGE 1 → Orders (ACCEPTED + NEW)
app.get("/", async (req, res) => {
  try {
    const response = await axios.get(
      "https://api.moysklad.ru/api/remap/1.2/entity/customerorder",
      {
        headers: { Authorization: `Bearer ${TOKEN}` },
        params: { filter: "state.name=ACCEPTED;state.name=NEW" }
      }
    );

    let orders = [];

for (let order of response.data.rows) {
  const counterparty = await getName(order.agent.meta.href);
  const owner = await getName(order.owner.meta.href);
  const status = await getName(order.state.meta.href);

  // 🔥 Fetch positions to calculate total quantity
  const posRes = await axios.get(
    `https://api.moysklad.ru/api/remap/1.2/entity/customerorder/${order.id}/positions`,
    {
      headers: { Authorization: `Bearer ${TOKEN}` }
    }
  );

  let totalQty = 0;

  for (let item of posRes.data.rows) {
    totalQty += item.quantity;
  }

  orders.push({
    id: order.id,
    name: order.name,
    counterparty,
    owner,
    status,
    totalQty, // ✅ NEW
    shippingAddress: order.shipmentAddress // ✅ NEW
  });
}

    res.render("orders", { orders });

  } catch (err) {
    console.log(err.response?.data || err.message);
    res.send("Error loading orders");
  }
});

// 🔹 PAGE 2 → Packing List
app.get("/order/:id", async (req, res) => {
  try {
    const orderId = req.params.id;

    const response = await axios.get(
      `https://api.moysklad.ru/api/remap/1.2/entity/customerorder/${orderId}/positions`,
      {
        headers: { Authorization: `Bearer ${TOKEN}` }
      }
    );

    let items = [];

    for (let item of response.data.rows) {
      const productName = await getName(item.assortment.meta.href);

      items.push({
        name: productName,
        quantity: item.quantity
      });
    }

    res.render("packing", { items });

  } catch (err) {
    console.log(err.response?.data || err.message);
    res.send("Error loading packing list");
  }
});

// ✅ Works locally + Render
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});