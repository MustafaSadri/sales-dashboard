const express = require("express");
const axios = require("axios");
const app = express();

app.set("view engine", "ejs");

const TOKEN = "9fd5f39b94e6f4bf6a25a253b007488dd801f668";

// helper to get name from meta
async function getName(url) {
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  return res.data.name;
}

// 🔹 PAGE 1 → Accepted Orders
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

      orders.push({
        id: order.id,
        name: order.name,
        counterparty,
        owner,
        status,
        total: order.sum / 100
      });
    }

    res.render("orders", { orders });

  } catch (err) {
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

    res.render("packing", { items, orderId });

  } catch (err) {
    res.send("Error loading packing list");
  }
});

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});