// const axios = require("axios");

// const TOKEN = "9fd5f39b94e6f4bf6a25a253b007488dd801f668";

// async function getName(url) {
//   const res = await axios.get(url, {
//     headers: { Authorization: `Bearer ${TOKEN}` }
//   });
//   return res.data.name;
// }

// async function test() {
//   try {
//     const response = await axios.get(
//       "https://api.moysklad.ru/api/remap/1.2/entity/customerorder",
//       {
//         headers: {
//           Authorization: `Bearer ${TOKEN}`
//         },
//         params: {
//           filter: "state.name=ACCEPTED"
//         }
//       }
//     );

//     console.log("\n✅ FINAL OUTPUT:\n");

//     for (let order of response.data.rows) {

//       // 🔥 Fetch real data from meta links
//       const counterparty = await getName(order.agent.meta.href);
//       const owner = await getName(order.owner.meta.href);
//       const status = await getName(order.state.meta.href);

//       console.log({
//         orderNo: order.name,
//         counterparty,
//         owner,
//         status,
//         total: order.sum / 100
//       });
//     }

//   } catch (err) {
//     console.log("❌ Error:", err.response?.data || err.message);
//   }
// }

// test();


const axios = require("axios");

const TOKEN = "9fd5f39b94e6f4bf6a25a253b007488dd801f668";

// helper function to get name
async function getName(url) {
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  return res.data.name;
}

async function testPacking() {
  try {
    const ORDER_ID = "2132e4df-39e8-11f1-0a80-039b0001822a"; // change if needed

    const response = await axios.get(
      `https://api.moysklad.ru/api/remap/1.2/entity/customerorder/${ORDER_ID}/positions`,
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`
        }
      }
    );

    console.log("\n📦 PACKING LIST:\n");

    for (let item of response.data.rows) {
      const productName = await getName(item.assortment.meta.href);

      console.log({
        product: productName,
        quantity: item.quantity
      });
    }

  } catch (err) {
    console.log("❌ Error:", err.response?.data || err.message);
  }
}

testPacking();