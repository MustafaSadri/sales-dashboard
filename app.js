

const express = require("express");
const axios = require("axios");
const app = express();

app.set("view engine", "ejs");

// 🔐 Token from Render / .env
const TOKEN = process.env.TOKEN;
// const TOKEN = "9fd5f39b94e6f4bf6a25a253b007488dd801f668";

// 🔹 PAGE 1 → Orders (OPTIMIZED)
app.get("/", async (req, res) => {
  try {
    const response = await axios.get(
      "https://api.moysklad.ru/api/remap/1.2/entity/customerorder",
      {
        headers: { Authorization: `Bearer ${TOKEN}` },
        params: {
          filter: "state.name=ACCEPTED;state.name=NEW",
          expand: "agent,owner,state", // 🔥 removes extra API calls
          limit: 20
        }
      }
    );

    const orders = await Promise.all(
      response.data.rows.map(async (order) => {

        // 🔹 Fetch positions (ONLY for quantity)
        const posRes = await axios.get(
          `https://api.moysklad.ru/api/remap/1.2/entity/customerorder/${order.id}/positions`,
          {
            headers: { Authorization: `Bearer ${TOKEN}` }
          }
        );

        let totalQty = 0;
        posRes.data.rows.forEach(item => {
          totalQty += item.quantity;
        });

        return {
          id: order.id,
          name: order.name,
          counterparty: order.agent?.name,
          owner: order.owner?.name,
          status: order.state?.name,
          totalQty,
          shippingAddress: order.shipmentAddress
        };
      })
    );

    res.render("orders", { orders });

  } catch (err) {
    console.log("❌ ERROR:", err.response?.data || err.message);
    res.send("Error loading orders");
  }
});


// 🔹 PAGE 2 → Packing List (FIXED + FAST)
app.get("/order/:id", async (req, res) => {
  try {
    const orderId = req.params.id;

    // 🔹 Get order details
    const orderRes = await axios.get(
      `https://api.moysklad.ru/api/remap/1.2/entity/customerorder/${orderId}`,
      {
        headers: { Authorization: `Bearer ${TOKEN}` }
      }
    );

    const shippingAddress = orderRes.data.shipmentAddress;
    const orderName = orderRes.data.name;

    // 🔹 Get positions WITH product names (no extra calls)
    const response = await axios.get(
      `https://api.moysklad.ru/api/remap/1.2/entity/customerorder/${orderId}/positions`,
      {
        headers: { Authorization: `Bearer ${TOKEN}` },
        params: {
          expand: "assortment" // 🔥 key fix
        }
      }
    );

    const items = response.data.rows.map(item => ({
      name: item.assortment?.name || "No name",
      quantity: item.quantity
    }));

    res.render("packing", {
      items,
      shippingAddress,
      orderName
    });

  } catch (err) {
    console.log("❌ ERROR:", err.response?.data || err.message);
    res.send("Error loading packing list");
  }
});


// ✅ PORT (Render compatible)
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});