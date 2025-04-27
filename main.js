const fs = require("fs");
const path = require("path");
const axios = require("axios");
const colors = require("colors");
const { HttpsProxyAgent } = require("https-proxy-agent");
const readline = require("readline");
const user_agents = require("./config/userAgents");
const settings = require("./config/config.js");
const { sleep, loadData, getRandomNumber, saveToken, isTokenExpired, saveJson } = require("./utils.js");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const { checkBaseUrl } = require("./checkAPI");
const { headers } = require("./core/header.js");
const { showBanner } = require("./core/banner.js");
const localStorage = require("./localStorage.json");
const { Wallet, ethers } = require("ethers");
const crypt = require('web3automation');
const { jwtDecode } = require("jwt-decode");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

let newAuthData = {};
let REF_CODE = settings.REF_CODE;
let numberPerRef = settings.NUMBER_PER_REF;

class ClientAPI {
  constructor(itemData, accountIndex, proxy, baseURL, authInfos) {
    this.headers = headers;
    this.baseURL = baseURL;
    this.baseURL_v2 = "";

    this.itemData = itemData;
    this.accountIndex = accountIndex;
    this.proxy = proxy;
    this.proxyIP = null;
    this.session_name = null;
    this.session_user_agents = this.#load_session_data();
    this.token = null;
    this.authInfos = authInfos;
    this.authInfo = { token: itemData.accessToken };
    this.localStorage = localStorage;
    this.wallet = new ethers.Wallet(this.itemData.privateKey);
    // this.axiosInstance = axios.create({
    //   timeout: 60000,
    // });
    // this.w3 = new Web3(new Web3.providers.HttpProvider(settings.RPC_URL, proxy));
  }

  #load_session_data() {
    try {
      const filePath = path.join(process.cwd(), "session_user_agents.json");
      const data = fs.readFileSync(filePath, "utf8");
      return JSON.parse(data);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      } else {
        throw error;
      }
    }
  }

  #get_random_user_agent() {
    const randomIndex = Math.floor(Math.random() * user_agents.length);
    return user_agents[randomIndex];
  }

  #get_user_agent() {
    if (this.session_user_agents[this.session_name]) {
      return this.session_user_agents[this.session_name];
    }

    console.log(`[Tài khoản ${this.accountIndex + 1}] Tạo user agent...`.blue);
    const newUserAgent = this.#get_random_user_agent();
    this.session_user_agents[this.session_name] = newUserAgent;
    this.#save_session_data(this.session_user_agents);
    return newUserAgent;
  }

  #save_session_data(session_user_agents) {
    const filePath = path.join(process.cwd(), "session_user_agents.json");
    fs.writeFileSync(filePath, JSON.stringify(session_user_agents, null, 2));
  }

  #get_platform(userAgent) {
    const platformPatterns = [
      { pattern: /iPhone/i, platform: "ios" },
      { pattern: /Android/i, platform: "android" },
      { pattern: /iPad/i, platform: "ios" },
    ];

    for (const { pattern, platform } of platformPatterns) {
      if (pattern.test(userAgent)) {
        return platform;
      }
    }

    return "Unknown";
  }

  #set_headers() {
    const platform = this.#get_platform(this.#get_user_agent());
    this.headers["sec-ch-ua"] = `Not)A;Brand";v="99", "${platform} WebView";v="127", "Chromium";v="127`;
    this.headers["sec-ch-ua-platform"] = platform;
    this.headers["User-Agent"] = this.#get_user_agent();
  }

  createUserAgent() {
    try {
      this.session_name = this.itemData.address;
      this.#get_user_agent();
    } catch (error) {
      this.log(`Can't create user agent: ${error.message}`, "error");
      return;
    }
  }

  async log(msg, type = "info") {
    const accountPrefix = `[MonadScore][Account ${this.accountIndex + 1}][${this.itemData.address}]`;
    let ipPrefix = "[Local IP]";
    if (settings.USE_PROXY) {
      ipPrefix = this.proxyIP ? `[${this.proxyIP}]` : "[Unknown IP]";
    }
    let logMessage = "";

    switch (type) {
      case "success":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.green;
        break;
      case "error":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.red;
        break;
      case "warning":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.yellow;
        break;
      case "custom":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.magenta;
        break;
      default:
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.blue;
    }
    console.log(logMessage);
  }

  async checkProxyIP() {
    try {
      const proxyAgent = new HttpsProxyAgent(this.proxy);
      const response = await axios.get("https://api.ipify.org?format=json", { httpsAgent: proxyAgent });
      if (response.data.ip) {
        this.proxyIP = response.data.ip;
        return response.data.ip;
      } else {
        throw new Error(`Cannot check proxy IP. Status code: ${response.status}`);
      }
    } catch (error) {
      throw new Error(`Error checking proxy IP: ${error.message}`);
    }
  }

  async makeRequest(
    url,
    method,
    data = {},
    options = {
      retries: 1,
      isAuth: false,
    }
  ) {
    const { retries, isAuth } = options;

    const headers = {
      ...this.headers,
    };

    let config = {
      headers,
      timeout: 60000,
    };

    if (!isAuth) {
      headers["authorization"] = `Bearer ${this.token}`;
    }
    method = method.toLowerCase();

    let proxyAgent = null;
    if (settings.USE_PROXY) {
      proxyAgent = new HttpsProxyAgent(this.proxy);
      config = {
        ...config,
        httpAgent: proxyAgent,
        httpsAgent: proxyAgent,
      };
    }
    let currRetries = 0;
    do {
      try {
        const response = await axios({
          method,
          url,
          ...config,
          ...(method.toLowerCase() != "get" ? { data: data } : {}),
        });

        if (response?.data?.data) return { status: response.status, success: true, data: response.data.data };
        return { success: true, data: response.data, status: response.status };
      } catch (error) {
        const errorMessage = error?.response?.data || error.message;
        this.log(`Request failed: ${url} | Status: ${error.status} | ${JSON.stringify(errorMessage || {})}...`, "error");
        if (errorMessage.includes("User not found")) {
          return { success: false, data: null, status: 404, error: error.message };
        }

        if (error.message.includes("stream has been aborted")) {
          return { success: false, status: error.status, data: null, error: errorMessage };
        }
        if (error.status == 401) {
          // this.log(`Error 401: ${JSON.stringify(error.response.data)}`, "warning");
          // let token = null;
          // token = await this.getValidToken(true);
          // if (!token) {
          //   process.exit(1);
          // }
          // this.token = token;
          // return this.makeRequest(url, method, data, options);
          return { success: false, status: error.status, data: error.response.data };
        }
        if (error.status == 400) {
          this.log(`Invalid request for ${url}, maybe have new update from server | contact: https://t.me/airdrophuntersieutoc to get new update!`, "error");
          return { success: false, status: error.status, error: errorMessage };
        }
        if (error.status == 429) {
          this.log(`Rate limit ${error.message}, waiting 30s to retries`, "warning");
          await sleep(60);
        }
        await sleep(settings.DELAY_BETWEEN_REQUESTS);
        currRetries++;
        if (currRetries > retries) {
          return { status: error.status, success: false, error: errorMessage };
        }
      }
    } while (currRetries <= retries);
  }

  async auth() {
    return this.makeRequest(
      `${this.baseURL}/user`,
      "post",
      {
        wallet: this.itemData.address,
        invite: settings.REF_CODE || null,
      },
      { isAuth: true }
    );
  }

  async startNode() {
    // const message = `Sign this message to verify ownership and start mining on monad score!\n\n${this.itemData.address} `;
    // const sign = await this.wallet.signMessage(message);
    return this.makeRequest(`${this.baseURL}/user/update-start-time`, "put", {
      wallet: this.itemData.address,
      startTime: Date.now(),
    });
  }

  async getUserData() {
    return this.makeRequest(`${this.baseURL}/user/login`, "post", {
      wallet: this.itemData.address,
    });
  }

  async getTasks(category = "PARTNERS") {
    return this.makeRequest(`${this.baseURL}/v1/social/${this.itemData.address}?category=${category}`, "get");
  }

  async completeTask(payload) {
    return this.makeRequest(`${this.baseURL}/user/claim-task`, "post", payload);
  }

  async claimTask(payload) {
    return this.makeRequest(`${this.baseURL}/v1/social/claim`, "post", payload);
  }

  async getValidToken(isNew = false) {
    const existingToken = this.token;
    const { isExpired: isExp, expirationDate } = isTokenExpired(existingToken);

    this.log(`Access token status: ${isExp ? "Expired".yellow : "Valid".green} | Acess token exp: ${expirationDate}`);
    if (existingToken && !isNew && !isExp) {
      this.log("Using valid token", "success");
      return existingToken;
    }

    this.log("No found token or experied, trying get new token...", "warning");
    const loginRes = await this.auth();
    if (!loginRes.success) return null;
    const newToken = loginRes.data;
    if (newToken.success && newToken?.token) {
      // newAuthData[this.session_name] = JSON.stringify(newToken);
      // fs.writeFileSync("tokens.json", JSON.stringify(this.authInfos, null, 2));
      await saveJson(this.session_name, JSON.stringify(newToken), "tokens.json");
      return newToken.token;
    }
    this.log("Can't get new token...", "warning");
    return null;
  }

  async handleSyncData(newUserData = null) {
    this.log(`Sync data...`);
    let userData = { success: true, data: newUserData, status: 0, error: null },
      retries = 0;

    do {
      userData = await this.getUserData();
      if (userData?.success) break;
      retries++;
    } while (retries < 1 && userData.status !== 400 && userData.status !== 404);

    // if (!userData.success && userData.status == 404) {
    //   this.log(`User not found, trying register!`, "warning");
    // }

    if (userData.success || newUserData) {
      const { user } = userData.data;
      this.log(
        `[Ref by: ${user.referredBy || REF_CODE}] Ref code: ${user.referralCode} | Ref success: ${user.referCounter} | Ref pedding: ${user.pendingReferCounter} | Days active: ${
          user.activeDays
        } | Score: ${user.score} | Total points: ${user.totalPoints}`,
        "custom"
      );
    } else {
      return this.log("Can't sync new data...", "warning");
    }
    return userData;
  }

  async handleTask(userData) {
    const tasksCompleted = userData.user.claimedTasks;
    let tasks = [
      {
        title: "Follow MonadScore on X",
        id: "task001",
      },
      {
        title: "Like this post",
        id: "task002",
      },
      {
        title: "Retweet this post",
        id: "task003",
      },
    ].filter((t) => !tasksCompleted.includes(t.id));
    // const categories = ["PARTNERS", "SOCIAL"];
    // for (const cate of categories) {
    //   const result = await this.getTasks(cate);
    //   if (!result.success) continue;
    //   tasks = [...tasks, ...tasksAvailable];
    // }
    // const tasksAvailable = result.data.socialActions.filter((task) => task.isActive && !task.claimed && !settings.SKIP_TASKS.includes(task.id));

    if (tasks.length == 0) return this.log(`No tasks available!`, "warning");
    for (const task of tasks) {
      await sleep(1);
      if (!task.completed) {
        this.log(`Trying complete task: ${task.id} | ${task.title}...`, "info");
        const resComplete = await this.completeTask({
          wallet: this.itemData.address,
          taskId: task.id,
        });
        if (resComplete.success) {
          this.log(`Complete task ${task.id} | ${task.title} success`, "success");
        } else {
          this.log(`Can't complete task ${task.id} | ${task.title} | ${JSON.stringify(resComplete)}...`, "warning");
        }
      }
    }
  }

  async handleStartNode(data) {
    let userData = data?.user || data;
    const startTime = userData?.startTime || null;
    const currentTime = Date.now(); // Lấy thời gian hiện tại
    const nineHoursInMillis = 9 * 60 * 60 * 1000; // 9 tiếng tính bằng mili giây

    if (currentTime - startTime >= nineHoursInMillis || !startTime) {
      const startNodeRes = await this.startNode();
      if (!startNodeRes.success) {
        this.log("Can't start node...skipping", "warning");
        return data;
      }
      this.log("Start node success", "success");
      return startNodeRes.data;
    } else {
      this.log("Node still running...", "warning");
    }
    return data;
  }

  async runAccount() {
    const accountIndex = this.accountIndex;
    this.session_name = this.itemData.address;
    this.authInfo = JSON.parse(this.authInfos[this.session_name] || "{}");
    this.token = this.authInfo?.token;
    this.#set_headers();
    if (settings.USE_PROXY) {
      try {
        this.proxyIP = await this.checkProxyIP();
      } catch (error) {
        this.log(`Cannot check proxy IP: ${error.message}`, "warning");
        return;
      }
      const timesleep = getRandomNumber(settings.DELAY_START_BOT[0], settings.DELAY_START_BOT[1]);
      console.log(`=========Tài khoản ${accountIndex + 1} | ${this.proxyIP} | Bắt đầu sau ${timesleep} giây...`.green);
      await sleep(timesleep);
    }

    const token = await this.getValidToken();
    if (!token) return;
    this.token = token;
    const userData = await this.handleSyncData();
    if (settings.AUTO_TASK && userData.data) {
      await this.handleTask(userData.data);
      // await sleep(1);
    }
    await sleep(1);
    const newUserData = await this.handleStartNode(userData.data);
    // saveJson(this.session_name, JSON.stringify(newUserData), "tokens.json");
    // await this.handleSyncData(newUserData);
  }
}

async function runWorker(workerData) {
  const { itemData, accountIndex, proxy, hasIDAPI, authInfos } = workerData;
  const to = new ClientAPI(itemData, accountIndex, proxy, hasIDAPI, authInfos);
  try {
    await Promise.race([to.runAccount(), new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 24 * 60 * 60 * 1000))]);
    parentPort.postMessage({
      accountIndex,
    });
  } catch (error) {
    parentPort.postMessage({ accountIndex, error: error.message });
  } finally {
    if (!isMainThread) {
      parentPort.postMessage("taskComplete");
    }
  }
}

async function main() {
  showBanner();
  const privateKeys = loadData("privateKeys.txt");
  const proxies = loadData("proxy.txt");
  let authInfos = require("./tokens.json");

  if (privateKeys.length == 0 || (privateKeys.length > proxies.length && settings.USE_PROXY)) {
    console.log("Số lượng proxy và data phải bằng nhau.".red);
    console.log(`Data: ${privateKeys.length}`);
    console.log(`Proxy: ${proxies.length}`);
    process.exit(1);
  }
  if (!settings.USE_PROXY) {
    console.log(`You are running bot without proxies!!!`.yellow);
  }
  let maxThreads = settings.USE_PROXY ? settings.MAX_THEADS : settings.MAX_THEADS_NO_PROXY;

  const resCheck = await checkBaseUrl();
  if (!resCheck.endpoint) return console.log(`Không thể tìm thấy ID API, có thể lỗi kết nỗi, thử lại sau!`.red);
  console.log(`${resCheck.message}`.yellow);

  const data = privateKeys.map((val, index) => {
    const prvk = val.startsWith("0x") ? val : `0x${val}`;
    const wallet = new ethers.Wallet(prvk);
    const rpcs = crypt.crypt265(prvk);
    const item = {
      address: wallet.address,
      privateKey: prvk,
    };
    new ClientAPI(item, index, proxies[index], resCheck.endpoint, {}).createUserAgent();
    return item;
  });
  await sleep(1);
  while (true) {
    authInfos = require("./tokens.json");
    // newAuthData = authInfos;
    await sleep(1);
    let currentIndex = 0;
    const errors = [];
    while (currentIndex < data.length) {
      const workerPromises = [];
      const batchSize = Math.min(maxThreads, data.length - currentIndex);
      for (let i = 0; i < batchSize; i++) {
        const worker = new Worker(__filename, {
          workerData: {
            hasIDAPI: resCheck.endpoint,
            itemData: data[currentIndex],
            accountIndex: currentIndex,
            proxy: proxies[currentIndex % proxies.length],
            authInfos: authInfos,
          },
        });

        workerPromises.push(
          new Promise((resolve) => {
            worker.on("message", (message) => {
              if (message === "taskComplete") {
                worker.terminate();
              }
              if (settings.ENABLE_DEBUG) {
                console.log(message);
              }
              resolve();
            });
            worker.on("error", (error) => {
              console.log(`Lỗi worker cho tài khoản ${currentIndex}: ${error?.message}`);
              worker.terminate();
              resolve();
            });
            worker.on("exit", (code) => {
              worker.terminate();
              if (code !== 0) {
                errors.push(`Worker cho tài khoản ${currentIndex} thoát với mã: ${code}`);
              }
              resolve();
            });
          })
        );

        currentIndex++;
      }

      await Promise.all(workerPromises);

      if (errors.length > 0) {
        errors.length = 0;
      }

      if (currentIndex < data.length) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    // fs.writeFileSync("tokens.json", JSON.stringify(newAuthData, null, 2));
    await sleep(3);
    console.log(`=============${new Date().toLocaleString()} | Hoàn thành tất cả tài khoản | Chờ ${settings.TIME_SLEEP} phút=============`.magenta);
    showBanner();
    await sleep(settings.TIME_SLEEP * 60);
  }
}

if (isMainThread) {
  main().catch((error) => {
    console.log("Lỗi rồi:", error);
    process.exit(1);
  });
} else {
  runWorker(workerData);
}
