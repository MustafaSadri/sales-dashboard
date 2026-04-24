// // const axios = require("axios");

// // const TOKEN = "9fd5f39b94e6f4bf6a25a253b007488dd801f668";

// // async function getName(url) {
// //   const res = await axios.get(url, {
// //     headers: { Authorization: `Bearer ${TOKEN}` }
// //   });
// //   return res.data.name;
// // }

// // async function test() {
// //   try {
// //     const response = await axios.get(
// //       "https://api.moysklad.ru/api/remap/1.2/entity/customerorder",
// //       {
// //         headers: {
// //           Authorization: `Bearer ${TOKEN}`
// //         },
// //         params: {
// //           filter: "state.name=ACCEPTED"
// //         }
// //       }
// //     );

// //     console.log("\n✅ FINAL OUTPUT:\n");

// //     for (let order of response.data.rows) {

// //       // 🔥 Fetch real data from meta links
// //       const counterparty = await getName(order.agent.meta.href);
// //       const owner = await getName(order.owner.meta.href);
// //       const status = await getName(order.state.meta.href);

// //       console.log({
// //         orderNo: order.name,
// //         counterparty,
// //         owner,
// //         status,
// //         total: order.sum / 100
// //       });
// //     }

// //   } catch (err) {
// //     console.log("❌ Error:", err.response?.data || err.message);
// //   }
// // }

// // test();


// const axios = require("axios");

// const TOKEN = "9fd5f39b94e6f4bf6a25a253b007488dd801f668";


// async function getOrders() {
//   try {
//     const response = await axios.get(
//       "https://api.moysklad.ru/api/remap/1.2/entity/customerorder",
//       {
//         headers: {
//           Authorization: `Bearer ${TOKEN}`
//         },
//         params: {
//           filter: "state.name=ACCEPTED;state.name=NEW",
//           expand: "agent,owner,state,positions.assortment",
//           limit: 20
//         }
//       }
//     );

//     console.log("\n📦 ORDERS:\n");

//     for (let order of response.data.rows) {
//       let totalQty = 0;

//       order.positions?.rows?.forEach(item => {
//         totalQty += item.quantity;
//       });

//       console.log({
//         orderNo: order.name,
//         customer: order.agent?.name,
//         owner: order.owner?.name,
//         status: order.state?.name,
//         totalQty
//       });
//     }

//   } catch (err) {
//     console.log("❌ Error:", err.response?.data || err.message);
//   }
// }

// getOrders();


const axios = require("axios");

const TOKEN = "ccae55834a1e1b89e76dcafb9ffb56198719c93d";

async function getOrders() {
  try {
    const response = await axios.get(
      "https://api.moysklad.ru/api/remap/1.2/entity/customerorder",
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`
        },
        params: {
          filter: "state.name=ACCEPTED;state.name=NEW",
          expand: "agent,owner,state,store,positions.assortment", // ✅ added store
          limit: 20
        }
      }
    );

    console.log("\n📦 ORDERS:\n");

    for (let order of response.data.rows) {
      let totalQty = 0;

      order.positions?.rows?.forEach(item => {
        totalQty += item.quantity;
      });

      console.log({
        orderNo: order.name,
        customer: order.agent?.name,
        owner: order.owner?.name,
        status: order.state?.name,
        warehouse: order.store?.name, // ✅ THIS IS YOUR LOCATION
        totalQty
      });
    }

  } catch (err) {
    console.log("❌ Error:", err.response?.data || err.message);
  }
}

getOrders();

