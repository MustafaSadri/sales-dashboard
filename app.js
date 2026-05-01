const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();

app.set("view engine", "ejs");

loadEnvFile();

const TOKEN = process.env.TOKEN;
const API_BASE = "https://api.moysklad.ru/api/remap/1.2";
const ORDER_CACHE_MS = 30000;
const ORDER_STALE_MS = 5 * 60 * 1000;
const ORDER_TOTAL_CACHE_MS = 10 * 60 * 1000;
const SHIPMENT_STATUS_CACHE_MS = 30000;
const PACKING_CACHE_MS = 5 * 60 * 1000;
const MAX_PACKING_CACHE_ITEMS = 100;
const MAX_ORDER_TOTAL_CACHE_ITEMS = 300;
const PREWARM_PACKING_COUNT = 5;
const ORDER_LIMIT = 50;
const MAX_ORDER_PAGES = 6;
const WAREHOUSE_NAME = "yuzhnie Varota";
const STATUS_PASSCODE = process.env.STATUS_PASSCODE || "1122";
const SHIPMENT_STATUS_NAME = process.env.SHIPMENT_STATUS_NAME || "SHIPMENT CREATED";
const ALLOWED_STATUSES = new Set(["ACCEPTED", "NEW", "READY TO DISPATCH"]);
const STATUS_TRANSITIONS = {
  NEW: "ACCEPTED",
  ACCEPTED: "READY TO DISPATCH",
  "READY TO DISPATCH": "DISPATCHED"
};
const STATUS_ACTION_LABELS = {
  ACCEPTED: "Accept",
  "READY TO DISPATCH": "Ready to Dispatch",
  DISPATCHED: "Dispatch"
};
const STATES_CACHE_MS = 10 * 60 * 1000;

let ordersCache = {
  expiresAt: 0,
  staleUntil: 0,
  data: []
};

const packingCache = new Map();
const orderTotalCache = new Map();
const shipmentStatusCache = new Map();
const packingLoadPromises = new Map();
let ordersRefreshPromise = null;
let statesCache = {
  expiresAt: 0,
  data: []
};
let demandStatesCache = {
  expiresAt: 0,
  data: []
};

const api = axios.create({
  baseURL: API_BASE,
  timeout: 15000
});

app.use(express.urlencoded({ extended: false }));

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");

  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsAt = trimmed.indexOf("=");

    if (equalsAt === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsAt).trim();
    const value = trimmed.slice(equalsAt + 1).trim().replace(/^["']|["']$/g, "");

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

app.get("/healthz", (req, res) => {
  res.status(200).send("ok");
});

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shouldRetry(err) {
  const status = err.response?.status;

  if (!status) {
    return true;
  }

  return status === 429 || status >= 500;
}

function logApiError(err, url) {
  const status = err.response?.status;
  const details = err.response?.data?.errors?.[0]?.error || err.response?.data?.message;
  const reason = status ? `HTTP ${status}` : err.code || err.message;

  console.log("API Error:", reason, url, details || "");
}

async function apiRequestWithRetry(method, url, options = {}, retries = 2) {
  try {
    return await api.request({
      method,
      url,
      ...options,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...options.headers
      }
    });
  } catch (err) {
    logApiError(err, url);

    if (retries > 0 && shouldRetry(err)) {
      console.log("Retrying API request...");
      await wait((3 - retries) * 500 + 1000);
      return apiRequestWithRetry(method, url, options, retries - 1);
    }

    throw err;
  }
}

async function fetchWithRetry(url, options = {}, retries = 2) {
  return apiRequestWithRetry("get", url, options, retries);
}

async function putWithRetry(url, data, options = {}, retries = 2) {
  return apiRequestWithRetry("put", url, { ...options, data }, retries);
}

async function postWithRetry(url, data, options = {}, retries = 2) {
  return apiRequestWithRetry("post", url, { ...options, data }, retries);
}

function isWantedOrder(order) {
  return order.store?.name === WAREHOUSE_NAME && ALLOWED_STATUSES.has(order.state?.name);
}

function getNextStatus(status) {
  return STATUS_TRANSITIONS[status] || null;
}

function getStatusActionLabel(status) {
  const nextStatus = getNextStatus(status);

  return nextStatus ? STATUS_ACTION_LABELS[nextStatus] : null;
}

function addStatusAction(order) {
  const nextStatus = getNextStatus(order.status);
  const shipmentCreated = Boolean(order.shipmentCreated);

  return {
    ...order,
    shipmentCreated,
    nextStatus,
    statusActionLabel: getStatusActionLabel(order.status),
    canCreateShipment: order.status === "READY TO DISPATCH" && !shipmentCreated
  };
}

function findCachedOrder(orderId) {
  return ordersCache.data.find(order => order.id === orderId) || null;
}

function clearOrdersCache() {
  ordersCache = {
    expiresAt: 0,
    staleUntil: 0,
    data: []
  };
}

function setFastPageCache(res) {
  res.set("Cache-Control", "private, max-age=30");
}

function setNoStore(res) {
  res.set("Cache-Control", "no-store");
}

function getCachedPacking(orderId) {
  const cached = packingCache.get(orderId);

  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    packingCache.delete(orderId);
    return null;
  }

  return cached.data;
}

function getAnyCachedPacking(orderId) {
  return packingCache.get(orderId)?.data || null;
}

function savePackingCache(orderId, data) {
  if (packingCache.size >= MAX_PACKING_CACHE_ITEMS) {
    const oldestKey = packingCache.keys().next().value;
    packingCache.delete(oldestKey);
  }

  packingCache.set(orderId, {
    expiresAt: Date.now() + PACKING_CACHE_MS,
    data
  });
}

function getCachedOrderTotal(orderId) {
  const cached = orderTotalCache.get(orderId);

  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    orderTotalCache.delete(orderId);
    return null;
  }

  return cached.totalQty;
}

function saveOrderTotalCache(orderId, totalQty) {
  if (orderTotalCache.size >= MAX_ORDER_TOTAL_CACHE_ITEMS) {
    const oldestKey = orderTotalCache.keys().next().value;
    orderTotalCache.delete(oldestKey);
  }

  orderTotalCache.set(orderId, {
    expiresAt: Date.now() + ORDER_TOTAL_CACHE_MS,
    totalQty
  });
}

function getCachedShipmentStatus(orderId) {
  const cached = shipmentStatusCache.get(orderId);

  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    shipmentStatusCache.delete(orderId);
    return null;
  }

  return cached;
}

function saveShipmentStatus(orderId, shipment) {
  shipmentStatusCache.set(orderId, {
    exists: Boolean(shipment),
    shipment: shipment || null,
    expiresAt: Date.now() + SHIPMENT_STATUS_CACHE_MS
  });
}

async function getOrderTotalQty(orderId) {
  const cached = getCachedOrderTotal(orderId);

  if (cached !== null) {
    return cached;
  }

  try {
    const posRes = await fetchWithRetry(`/entity/customerorder/${orderId}/positions`);
    const totalQty = posRes.data.rows.reduce((sum, item) => sum + item.quantity, 0);

    saveOrderTotalCache(orderId, totalQty);

    return totalQty;
  } catch (err) {
    console.log("Could not load order quantity:", orderId, err.response?.status || err.message);
    return 0;
  }
}

async function getStates() {
  const now = Date.now();

  if (statesCache.expiresAt > now && statesCache.data.length > 0) {
    return statesCache.data;
  }

  const response = await fetchWithRetry("/entity/customerorder/metadata");
  const states = response.data.states || [];

  statesCache = {
    expiresAt: now + STATES_CACHE_MS,
    data: states
  };

  return states;
}

async function getDemandStates() {
  const now = Date.now();

  if (demandStatesCache.expiresAt > now && demandStatesCache.data.length > 0) {
    return demandStatesCache.data;
  }

  const response = await fetchWithRetry("/entity/demand/metadata");
  const states = response.data.states || [];

  demandStatesCache = {
    expiresAt: now + STATES_CACHE_MS,
    data: states
  };

  return states;
}

async function getMoyskladStateByName(statusName) {
  const states = await getStates();
  const selected = states.find(
    state => state.name && state.name.toLowerCase() === statusName.toLowerCase()
  );

  if (!selected) {
    throw new Error(`Status not found in MoySklad: ${statusName}`);
  }

  return selected;
}

async function getDemandStateByName(statusName) {
  const states = await getDemandStates();
  const selected = states.find(
    state => state.name && state.name.toLowerCase() === statusName.toLowerCase()
  );

  if (!selected) {
    throw new Error(`Shipment status not found in MoySklad: ${statusName}`);
  }

  return selected;
}

async function getOrderForStatusChange(orderId) {
  const cached = findCachedOrder(orderId);

  if (cached) {
    return cached;
  }

  const response = await fetchWithRetry(`/entity/customerorder/${orderId}`, {
    params: {
      expand: "state"
    }
  });

  return {
    id: response.data.id,
    name: response.data.name,
    status: response.data.state?.name
  };
}

async function getFullOrderForShipment(orderId) {
  const [orderRes, positionsRes] = await Promise.all([
    fetchWithRetry(`/entity/customerorder/${orderId}`, {
      params: {
        expand: "agent,organization,store,state,demands"
      }
    }),
    fetchWithRetry(`/entity/customerorder/${orderId}/positions`, {
      params: {
        expand: "assortment"
      }
    })
  ]);

  return {
    ...orderRes.data,
    positions: positionsRes.data.rows || []
  };
}

function addShipmentStatus(order) {
  if (order.status !== "READY TO DISPATCH") {
    return addStatusAction(order);
  }

  const hasDemandInMoySklad = order.demands && order.demands.length > 0;
  const hasCachedDemand = getCachedShipmentStatus(order.id)?.exists;

  return addStatusAction({
    ...order,
    shipmentCreated: Boolean(hasDemandInMoySklad || hasCachedDemand)
  });
}

function buildShipmentPositions(order) {
  return order.positions.map(position => {
    const shipmentPosition = {
      quantity: position.quantity,
      price: position.price || 0,
      discount: position.discount || 0,
      vat: position.vat,
      assortment: {
        meta: position.assortment.meta
      }
    };

    if (position.vatEnabled !== undefined) {
      shipmentPosition.vatEnabled = position.vatEnabled;
    }

    return shipmentPosition;
  });
}

function validateShipmentOrder(order) {
  if (order.store?.name !== WAREHOUSE_NAME) {
    throw new Error("Shipment can be created only for yuzhnie Varota warehouse");
  }

  if (order.state?.name !== "READY TO DISPATCH") {
    throw new Error("Shipment can be created only for READY TO DISPATCH orders");
  }

  if (!order.positions.length) {
    throw new Error("Order has no positions");
  }

  if (!order.agent?.meta || !order.organization?.meta || !order.store?.meta) {
    throw new Error("Order is missing required MoySklad fields");
  }
}

async function ensureShipmentExists(orderId) {
  const order = await getFullOrderForShipment(orderId);

  validateShipmentOrder(order);

  if (order.demands && order.demands.length > 0) {
    const existingShipment = order.demands[0];
    saveShipmentStatus(orderId, existingShipment);

    return {
      created: false,
      shipment: existingShipment,
      order
    };
  }

  const shipmentState = await getDemandStateByName(SHIPMENT_STATUS_NAME);

  const response = await postWithRetry("/entity/demand", {
    name: order.name,
    applicable: true,
    state: {
      meta: shipmentState.meta
    },
    agent: {
      meta: order.agent.meta
    },
    organization: {
      meta: order.organization.meta
    },
    store: {
      meta: order.store.meta
    },
    customerOrder: {
      meta: order.meta
    },
    positions: buildShipmentPositions(order)
  });

  saveShipmentStatus(orderId, response.data);
  clearOrdersCache();

  return {
    created: true,
    shipment: response.data,
    order
  };
}

async function assertShipmentExistsForDispatch(orderId) {
  const order = await getFullOrderForShipment(orderId);

  validateShipmentOrder(order);

  if (!order.demands || order.demands.length === 0) {
    throw new Error("Create shipment before dispatching this order");
  }

  return order.demands[0];
}

async function getFreshOrderForStatusChange(orderId) {
  const response = await fetchWithRetry(`/entity/customerorder/${orderId}`, {
    params: {
      expand: "state"
    }
  });

  return {
    id: response.data.id,
    name: response.data.name,
    status: response.data.state?.name
  };
}

function assertAllowedStatusChange(order, wantedStatus) {
  const nextStatus = getNextStatus(order.status);

  if (!nextStatus || nextStatus.toLowerCase() !== wantedStatus.toLowerCase()) {
    throw new Error(`Cannot change ${order.status || "unknown"} order to ${wantedStatus}`);
  }
}

function isValidStatusPasscode(passcode) {
  return String(passcode || "") === STATUS_PASSCODE;
}

async function updateOrderStatus(orderId, wantedStatus) {
  const order = await getFreshOrderForStatusChange(orderId);

  assertAllowedStatusChange(order, wantedStatus);

  if (wantedStatus === "DISPATCHED") {
    await assertShipmentExistsForDispatch(orderId);
  }

  const selectedState = await getMoyskladStateByName(wantedStatus);

  await putWithRetry(`/entity/customerorder/${orderId}`, {
    state: {
      meta: selectedState.meta
    }
  });

  clearOrdersCache();

  return {
    order,
    status: selectedState.name
  };
}

async function refreshOrders(options = {}) {
  if (ordersRefreshPromise) {
    return ordersRefreshPromise;
  }

  ordersRefreshPromise = (async () => {
    let allOrders = [];
    let offset = 0;
    let pagesChecked = 0;

    while (allOrders.length < 20 && pagesChecked < MAX_ORDER_PAGES) {
      const response = await fetchWithRetry("/entity/customerorder", {
        params: {
          expand: "agent,owner,state,store,demands",
          limit: ORDER_LIMIT,
          offset,
          order: "moment,desc"
        }
      });

      const rows = response.data.rows || [];

      if (rows.length === 0) {
        break;
      }

      allOrders.push(...rows.filter(isWantedOrder));
      offset += ORDER_LIMIT;
      pagesChecked += 1;
    }

    const finalOrders = allOrders.slice(0, 20);
    const orders = await Promise.all(
      finalOrders.map(async (order) => addShipmentStatus({
        id: order.id,
        meta: order.meta,
        name: order.name,
        counterparty: order.agent?.name,
        owner: order.owner?.name,
        status: order.state?.name,
        demands: order.demands,
        totalQty: await getOrderTotalQty(order.id),
        shippingAddress: order.shipmentAddress,
        date: order.moment
      }))
    );
    const now = Date.now();

    ordersCache = {
      expiresAt: now + ORDER_CACHE_MS,
      staleUntil: now + ORDER_STALE_MS,
      data: orders
    };

    prewarmPackingCache(orders);

    return orders;
  })().finally(() => {
    ordersRefreshPromise = null;
  });

  return ordersRefreshPromise;
}

function refreshOrdersInBackground() {
  refreshOrders().catch(err => {
    console.log("Background orders refresh failed:", err.response?.status || err.message);
  });
}

function prewarmPackingCache(orders) {
  setTimeout(async () => {
    const ordersToWarm = orders.slice(0, PREWARM_PACKING_COUNT);

    for (const order of ordersToWarm) {
      if (!getCachedPacking(order.id)) {
        try {
          await loadPacking(order.id);
        } catch (err) {
          console.log("Packing prewarm failed:", order.id, err.response?.status || err.message);
        }
      }
    }
  }, 0);
}

async function loadOrders() {
  const now = Date.now();

  if (ordersCache.expiresAt > now) {
    return ordersCache.data;
  }

  if (ordersCache.data.length > 0 && ordersCache.staleUntil > now) {
    refreshOrdersInBackground();
    return ordersCache.data;
  }

  return refreshOrders();
}

async function loadPacking(orderId) {
  const cached = getCachedPacking(orderId);

  if (cached) {
    return cached;
  }

  if (packingLoadPromises.has(orderId)) {
    return packingLoadPromises.get(orderId);
  }

  const promise = (async () => {
    const [orderRes, positionsRes] = await Promise.all([
      fetchWithRetry(`/entity/customerorder/${orderId}`),
      fetchWithRetry(`/entity/customerorder/${orderId}/positions`, {
        params: {
          expand: "assortment"
        }
      })
    ]);

    const items = positionsRes.data.rows.map(item => ({
      name: item.assortment?.name || "No name",
      quantity: item.quantity
    }));
    const packing = {
      shippingAddress: orderRes.data.shipmentAddress,
      orderName: orderRes.data.name,
      items
    };

    saveOrderTotalCache(
      orderId,
      items.reduce((sum, item) => sum + item.quantity, 0)
    );
    savePackingCache(orderId, packing);

    return packing;
  })().finally(() => {
    packingLoadPromises.delete(orderId);
  });

  packingLoadPromises.set(orderId, promise);

  return promise;
}

app.get("/", async (req, res) => {
  try {
    if (!TOKEN) {
      console.log("Missing TOKEN environment variable");
      return res.render("orders", { orders: [] });
    }

    const orders = req.query.updated
      ? await refreshOrders({ forceShipmentRefresh: true })
      : await loadOrders();

    if (req.query.updated) {
      setNoStore(res);
    } else {
      setFastPageCache(res);
    }

    res.render("orders", { orders });
  } catch (err) {
    console.log("Final error loading orders:", err.response?.status || err.message);
    res.render("orders", { orders: [] });
  }
});

app.get("/confirm-status/:id/:status", async (req, res) => {
  try {
    if (!TOKEN) {
      console.log("Missing TOKEN environment variable");
      return res.send("Status update is not available");
    }

    const orderId = req.params.id;
    const wantedStatus = decodeURIComponent(req.params.status);
    const order = await getOrderForStatusChange(orderId);

    assertAllowedStatusChange(order, wantedStatus);
    setNoStore(res);
    res.render("confirm-status", {
      order,
      wantedStatus,
      actionLabel: STATUS_ACTION_LABELS[wantedStatus] || wantedStatus,
      passcodeError: null,
      statusError: null
    });
  } catch (err) {
    console.log("Status confirmation error:", err.response?.status || err.message);
    res.send("Cannot update this status");
  }
});

app.post("/update-status/:id/:status", async (req, res) => {
  try {
    if (!TOKEN) {
      console.log("Missing TOKEN environment variable");
      return res.send("Failed to update status");
    }

    const orderId = req.params.id;
    const wantedStatus = decodeURIComponent(req.params.status);
    const passcode = req.body.passcode;

    if (!isValidStatusPasscode(passcode)) {
      const order = await getOrderForStatusChange(orderId);

      assertAllowedStatusChange(order, wantedStatus);
      setNoStore(res);
      return res.status(403).render("confirm-status", {
        order,
        wantedStatus,
        actionLabel: STATUS_ACTION_LABELS[wantedStatus] || wantedStatus,
        passcodeError: "Wrong passcode",
        statusError: null
      });
    }

    await updateOrderStatus(orderId, wantedStatus);
    setNoStore(res);
    res.redirect("/?updated=1");
  } catch (err) {
    console.log("STATUS UPDATE ERROR:", err.response?.data || err.message);

    try {
      const orderId = req.params.id;
      const wantedStatus = decodeURIComponent(req.params.status);
      const order = await getOrderForStatusChange(orderId);

      setNoStore(res);
      return res.status(400).render("confirm-status", {
        order,
        wantedStatus,
        actionLabel: STATUS_ACTION_LABELS[wantedStatus] || wantedStatus,
        passcodeError: null,
        statusError: err.message || "Failed to update status"
      });
    } catch (renderErr) {
      console.log("STATUS ERROR RENDER FAILED:", renderErr.response?.data || renderErr.message);
      res.send("Failed to update status");
    }
  }
});

app.get("/confirm-shipment/:id", async (req, res) => {
  try {
    if (!TOKEN) {
      console.log("Missing TOKEN environment variable");
      return res.send("Shipment creation is not available");
    }

    const orderId = req.params.id;
    const order = await getOrderForStatusChange(orderId);

    if (order.status !== "READY TO DISPATCH") {
      return res.send("Shipment can be created only for READY TO DISPATCH orders");
    }

    setNoStore(res);
    res.render("confirm-shipment", {
      order,
      passcodeError: null,
      shipmentMessage: null
    });
  } catch (err) {
    console.log("Shipment confirmation error:", err.response?.status || err.message);
    res.send("Cannot create shipment for this order");
  }
});

app.post("/create-shipment/:id", async (req, res) => {
  try {
    if (!TOKEN) {
      console.log("Missing TOKEN environment variable");
      return res.send("Failed to create shipment");
    }

    const orderId = req.params.id;
    const passcode = req.body.passcode;

    if (!isValidStatusPasscode(passcode)) {
      const order = await getOrderForStatusChange(orderId);

      setNoStore(res);
      return res.status(403).render("confirm-shipment", {
        order,
        passcodeError: "Wrong passcode",
        shipmentMessage: null
      });
    }

    const result = await ensureShipmentExists(orderId);

    setNoStore(res);
    return res.render("confirm-shipment", {
      order: {
        id: result.order.id,
        name: result.order.name,
        status: result.order.state?.name
      },
      passcodeError: null,
      shipmentMessage: result.created
        ? "Shipment created successfully"
        : "Shipment already exists for this order"
    });
  } catch (err) {
    console.log("SHIPMENT CREATE ERROR:", err.response?.data || err.message);
    res.send("Failed to create shipment");
  }
});

app.get("/order/:id", async (req, res) => {
  try {
    if (!TOKEN) {
      console.log("Missing TOKEN environment variable");
      return res.send("Error loading packing list");
    }

    const orderId = req.params.id;

    const { items, shippingAddress, orderName } = await loadPacking(orderId);

    setFastPageCache(res);
    res.render("packing", {
      items,
      shippingAddress,
      orderName
    });
  } catch (err) {
    console.log("Error loading packing list:", err.response?.status || err.message);
    const cached = getAnyCachedPacking(req.params.id);

    if (cached) {
      setFastPageCache(res);
      return res.render("packing", cached);
    }

    res.send("Error loading packing list");
  }
});

app.get("/transfers", async (req, res) => {
  try {
    if (!TOKEN) return res.send("Missing TOKEN");
    const response = await fetchWithRetry("/entity/move", {
      params: { 
        limit: 5, 
        order: "moment,desc",
        expand: "sourceStore,targetStore"
      }
    });
    
    const transfers = (response.data.rows || []).map(m => {
      const d = new Date(m.moment);
      const onlyDate = String(d.getDate()).padStart(2, "0") + "." + String(d.getMonth() + 1).padStart(2, "0") + "." + d.getFullYear() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
      return {
        id: m.id,
        name: m.name,
        date: onlyDate,
        source: m.sourceStore?.name,
        target: m.targetStore?.name
      };
    });
    
    setNoStore(res);
    res.render("transfers", { transfers });
  } catch (err) {
    console.log("Transfers error:", err.message);
    res.send("Error loading transfers");
  }
});

app.get("/transfer/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const [moveRes, posRes] = await Promise.all([
      fetchWithRetry(`/entity/move/${id}`, { params: { expand: "sourceStore,targetStore" } }),
      fetchWithRetry(`/entity/move/${id}/positions`, { params: { expand: "assortment" } })
    ]);
    
    const m = moveRes.data;
    const items = (posRes.data.rows || []).map(item => ({
      name: item.assortment?.name || "No name",
      quantity: item.quantity
    }));
    
    setNoStore(res);
    res.render("transfer-packing", {
      transferName: m.name,
      source: m.sourceStore?.name,
      target: m.targetStore?.name,
      items
    });
  } catch (err) {
    console.log("Transfer packing error:", err.message);
    res.send("Error loading transfer items");
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
