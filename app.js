
const express = require("express");
const axios = require("axios");
const app = express();

app.set("view engine", "ejs");

// 🔐 TOKEN
const TOKEN = process.env.TOKEN;

// const TOKEN = "ccae55834a1e1b89e76dcafb9ffb56198719c93d";

// 🔁 RETRY FUNCTION (VERY IMPORTANT)
async function fetchWithRetry(url, options, retries = 3) {
  try {
    return await axios.get(url, options);
  } catch (err) {
    console.log("❌ API Error:", err.code || err.message);

    if (retries > 0) {
      console.log("🔁 Retrying...");
      await new Promise(res => setTimeout(res, 1000));
      return fetchWithRetry(url, options, retries - 1);
    }

    throw err;
  }
}

// 🔹 PAGE 1 → ORDERS
app.get("/", async (req, res) => {
  try {
    let allOrders = [];
    let offset = 0;
    const LIMIT = 50;

    while (allOrders.length < 20) {

      const response = await fetchWithRetry(
        "https://api.moysklad.ru/api/remap/1.2/entity/customerorder",
        {
          headers: { Authorization: `Bearer ${TOKEN}` },
          params: {
            expand: "agent,owner,state,store",
            limit: LIMIT,
            offset: offset,
            order: "moment,desc"
          }
        }
      );

      const rows = response.data.rows;

      if (!rows || rows.length === 0) break;

      // ✅ FILTER (warehouse + status)
      const filtered = rows.filter(order =>
        order.store?.name === "yuzhnie Varota" &&
        (
          order.state?.name === "ACCEPTED" ||
          order.state?.name === "NEW"||
          order.state?.name === "READY TO DISPATCH"
        )
      );

      allOrders.push(...filtered);
      offset += LIMIT;
    }

    const finalOrders = allOrders.slice(0, 20);

    const orders = await Promise.all(
      finalOrders.map(async (order) => {

        const posRes = await fetchWithRetry(
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
          shippingAddress: order.shipmentAddress,
          date: order.moment
        };
      })
    );

    res.render("orders", { orders });

  } catch (err) {
    console.log("❌ FINAL ERROR:", err.message);

    // ✅ DO NOT CRASH PAGE
    res.render("orders", { orders: [] });
  }
});

// 🔹 PAGE 2 → PACKING LIST
app.get("/order/:id", async (req, res) => {
  try {
    const orderId = req.params.id;

    const orderRes = await fetchWithRetry(
      `https://api.moysklad.ru/api/remap/1.2/entity/customerorder/${orderId}`,
      {
        headers: { Authorization: `Bearer ${TOKEN}` }
      }
    );

    const shippingAddress = orderRes.data.shipmentAddress;
    const orderName = orderRes.data.name;

    const response = await fetchWithRetry(
      `https://api.moysklad.ru/api/remap/1.2/entity/customerorder/${orderId}/positions`,
      {
        headers: { Authorization: `Bearer ${TOKEN}` },
        params: {
          expand: "assortment"
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
    console.log("❌ ERROR:", err.message);
    res.send("Error loading packing list");
  }
});

// ✅ PORT
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});