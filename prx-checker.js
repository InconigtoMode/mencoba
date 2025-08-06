const tls = require("tls");
const cluster = require("cluster");
const os = require("os");
const fs = require("fs");

const color = {
    reset: "\x1b[0m",
    gray: (text) => `\x1b[90m${text}\x1b[0m`,
    blue: (text) => `\x1b[34m${text}\x1b[0m`,
    cyan: (text) => `\x1b[36m${text}\x1b[0m`,
    green: (text) => `\x1b[32m${text}\x1b[0m`,
    red: (text) => `\x1b[31m${text}\x1b[0m`,
    yellow: (text) => `\x1b[33m${text}\x1b[0m`,
};

function log(message, type = "info") {
    const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
    const prefix = {
        info: color.blue("[INFO]"),
        success: color.green("[SUCCESS]"),
        error: color.red("[ERROR]"),
    };
    console.log(`${color.gray(timestamp)} ${prefix[type] || prefix.info} ${message}`);
}

const formatDuration = (milliseconds) => {
    let totalSeconds = Math.floor(milliseconds / 1000);
    let hours = Math.floor(totalSeconds / 3600);
    let minutes = Math.floor((totalSeconds % 3600) / 60);
    let seconds = totalSeconds % 60;

    let formatted = [];
    if (hours > 0) formatted.push(`${hours} hours`);
    if (minutes > 0) formatted.push(`${minutes} minutes`);
    if (seconds > 0 || formatted.length === 0) formatted.push(`${seconds} seconds`);
    return formatted.join(" ");
};

if (cluster.isPrimary) {
    let completedWorkers = 0;
    let numCPUs;
    const startTime = Date.now();
    let totalProxiesFound = 0;
    const outputFile = `prxip.txt`;
    const jsonOutputFile = `prxip.json`;
    const activeProxies = [];
    fs.writeFileSync(outputFile, "Proxy,Port,Country,Organization\n");

    (async () => {
        try {
            log("Reading local proxy list...", "info");
            const prx = fs.readFileSync("./proxy/ProxyList.txt", "utf-8").trim().split("\n");
            const allIPs = [...new Set(prx)];
            numCPUs = Math.min(os.cpus().length, allIPs.length) || 4;
            const proxyPerThreads = Math.ceil(allIPs.length / numCPUs);
            log(`Loaded ${allIPs.length} proxies`, "success");
            log(`Starting checking proxy with ${numCPUs} threads`, "info");

            for (let i = 0; i < numCPUs; i++) {
                const startIndex = i * proxyPerThreads;
                if (startIndex >= allIPs.length) break;
                const workerProxy = allIPs.slice(startIndex, startIndex + proxyPerThreads);
                const worker = cluster.fork();
                worker.send({
                    proxies: workerProxy,
                    outputFile,
                });
                worker.on("message", (msg) => {
                    if (msg.type === "proxyFound") {
                        totalProxiesFound++;
                        activeProxies.push(msg.data);
                    }
                });
            }

            cluster.on("exit", () => {
                completedWorkers++;
                if (completedWorkers === numCPUs) {
                    fs.writeFileSync(jsonOutputFile, JSON.stringify(activeProxies, null, 2));
                    const duration = Date.now() - startTime;
                    log(`Scan completed in ${formatDuration(duration)}`, "success");
                    log(`Found ${totalProxiesFound} working proxies`, "success");
                    log(`Results saved to ${outputFile} and ${jsonOutputFile}`, "success");
                    process.exit(0);
                }
            });
        } catch (error) {
            log(`${error.message}`, "error");
            process.exit(1);
        }
    })();
} else {
    let proxies = [];
    let outputFile;

    process.on("message", (msg) => {
        if (msg.proxies) {
            proxies = msg.proxies;
            outputFile = msg.outputFile;

            checkProxies()
                .then(() => {
                    process.exit(0);
                })
                .catch((error) => {
                    log(`${error.message}`, "error");
                    process.exit(1);
                });
        }
    });

    async function checkIP(cok) {
        const [proxy, port = "443"] = cok.split(/[^a-zA-Z0-9.\n]+/);
        const sendRequest = (host, path, useProxy = true) => {
            return new Promise((resolve, reject) => {
                const start = Date.now();
                const socket = tls.connect({
                    host: useProxy ? proxy : host,
                    port: useProxy ? port : 443,
                    servername: host,
                }, () => {
                    const request = `GET ${path} HTTP/1.1\r\n` +
                        `Host: ${host}\r\n` +
                        `User-Agent: Mozilla/5.0\r\n` +
                        `Connection: close\r\n\r\n`;
                    socket.write(request);
                });
                let responseBody = "";
                socket.on("data", (data) => {
                    responseBody += data.toString();
                });
                socket.on("end", () => {
                    const body = responseBody.split("\r\n\r\n")[1] || "";
                    const latency = Date.now() - start;
                    resolve({ body, latency });
                });
                socket.on("error", (error) => {
                    reject(error);
                });
                socket.setTimeout(5000, () => {
                    reject(new Error("Request timeout"));
                    socket.end();
                });
            });
        };

        return new Promise(async (resolve) => {
            if (!cok) return resolve({ proxyip: false });
            try {
                const [ipinfo, myip] = await Promise.all([
                    sendRequest("myip.bexcode.us.to", "/", true),
                    sendRequest("myip.bexcode.us.to", "/", false),
                ]);
                const ipingfo = JSON.parse(ipinfo.body);
                const srvip = JSON.parse(myip.body);
                if (ipingfo.myip && ipingfo.myip !== srvip.myip) {
                    resolve({
                        proxy: proxy,
                        port: port,
                        proxyip: true,
                        ip: ipingfo.myip,
                        latency: ipinfo.latency,
                        ...ipingfo
                    });
                } else {
                    resolve({ proxyip: false });
                }
            } catch {
                resolve({ proxyip: false });
            }
        });
    }

    async function checkProxies() {
        const promises = [];
        const batchSize = 50;

        for (const proxy of proxies) {
            promises.push(
                checkIP(proxy).then((data) => {
                    if (data.proxyip) {
                        delete data.myip;
                        process.send({ type: "proxyFound", data });
                        const outputLine = `${data.proxy},${data.port},${data.countryCode},${data.org}\n`;
                        fs.appendFileSync(outputFile, outputLine);
                        log(`Found: ${color.cyan(data.proxy)}:${color.cyan(data.port)} | ${color.yellow(data.countryCode)} | ${color.blue(data.org)}`, "success");
                    }
                })
            );

            if (promises.length >= batchSize) {
                await Promise.all(promises);
                promises.length = 0;
            }
        }

        if (promises.length) {
            await Promise.all(promises);
        }
    }
}
