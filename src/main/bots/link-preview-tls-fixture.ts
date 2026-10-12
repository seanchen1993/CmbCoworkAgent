import { createServer, request } from "node:https"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import type { PublicPreviewRequest } from "./public-link-fetch"

// Public test-only key/certificate, never installed in production trust stores.
// Static fake-domain SANs and 2020–2100 validity remove external OpenSSL/time races
// from the same real TLS fixture on Windows, macOS and Linux.
const ca = `-----BEGIN CERTIFICATE-----
MIIDNTCCAh2gAwIBAgIUDvJj24fjXQycRb+rgtcYvdwdk80wDQYJKoZIhvcNAQEL
BQAwIDEeMBwGA1UEAwwVcHJldmlldy5jYW5kaWRhdGUubmV0MCAXDTIwMDEwMTAw
MDAwMFoYDzIxMDAwMTAxMDAwMDAwWjAgMR4wHAYDVQQDDBVwcmV2aWV3LmNhbmRp
ZGF0ZS5uZXQwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDAhl+GB6/S
mNg6g9Q0lWmSQymROb0zn9OCHt653y7A4w/X2+UUrwI94e/B13D90vJ4iluXUNEi
2rOnZ0976cEQb8bbEcyweIuVs3bRAZc9jdJj+e0HOXB0sHkYHvsOFeuQjRn4HPac
LwrQfPS1s83k65yOJD8tpcksUW2P7EMOrqiocaMBi41mvTmiuFf8S13RjA0eFUDJ
UsVJsP9e9Fk5au/mSrhIZDx43x7QELZ9GAYamglKD3WAnTYtx7y1jmA0LHIRSNQ/
n0i8NKF+5E6DFVuBtwhIiTR9le2ZXtrAff6DshYt+EXHY6C5bRu/WZliokDzP01N
ak/f/NZhmPrlAgMBAAGjZTBjME0GA1UdEQRGMESCFXByZXZpZXcuY2FuZGlkYXRl
Lm5ldIITaW1hZ2UuY2FuZGlkYXRlLm5ldIIWcmVkaXJlY3QuY2FuZGlkYXRlLm5l
dDASBgNVHRMBAf8ECDAGAQH/AgEAMA0GCSqGSIb3DQEBCwUAA4IBAQAZ9pPT07f3
SHBcWWLrcBGUw+HsVq0M5MWuubxeGNWGlUBc25xajJ9/usVb3nY8V3SvvSrBY3jj
sB/assX7kdHenGW5mfbrJ4A17rjtqGG1qoSohfVKpG0EQfm6mOCNzJoHftt1cswN
a96EO0OK4Eh6iVHrkQPaiaO1MVjrajRjuVvfyCZZbgM/aI8eSvCfzKB12j2BwE4F
3Fv28GEYr4kcN2USfNCMlmIatgfOr/DiPJkkiZ1nej4CS1jFTw8VjAb46TPvDUfj
nztEoT8Ff+3XhtYhViCDQyh7sZmZVZAVWCr2txJvSlg9WVQnsBaNkTiqoVYV8+9H
XyXyg8J0wJ77
-----END CERTIFICATE-----
`
const key = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDAhl+GB6/SmNg6
g9Q0lWmSQymROb0zn9OCHt653y7A4w/X2+UUrwI94e/B13D90vJ4iluXUNEi2rOn
Z0976cEQb8bbEcyweIuVs3bRAZc9jdJj+e0HOXB0sHkYHvsOFeuQjRn4HPacLwrQ
fPS1s83k65yOJD8tpcksUW2P7EMOrqiocaMBi41mvTmiuFf8S13RjA0eFUDJUsVJ
sP9e9Fk5au/mSrhIZDx43x7QELZ9GAYamglKD3WAnTYtx7y1jmA0LHIRSNQ/n0i8
NKF+5E6DFVuBtwhIiTR9le2ZXtrAff6DshYt+EXHY6C5bRu/WZliokDzP01Nak/f
/NZhmPrlAgMBAAECggEADN7+6bbqWDCWkM+UQzazoeRia0kvqbuh7Y/9m8dnY1xa
yGI1A2gRhOHDFb5pmVfov3Uf20glzzLNXMqmm6C8ovTCF+PC/4+eOgd55k5jq35n
hikPjGfYlD3hvqKAQ3MPi7CvP4aaLcYPBEdnqcfSovRl2UfkPxDswo0oFL2QHHNO
rgRpeFIZAhLXGz/IwVMXo2IYorZXx8JW8lX0UXPlMvTOcUScxd6x3nWSAaweP7u9
2Oq+Oi2IazwXiIx9Yd9Vf6SwLCJTX1iQKM34sHuqonZ0J4OIv3enOiBW8cPr9G3l
MSXLuZgc1v6iwZGlt9bLvtVLM2MrDfuxQWbImsoLOQKBgQD/MaUHwn4X+T28zPNC
lTEGtFL61IGIv3LtEYBetl8AtBSymnegGrCYM7ZYIStgOMX3x18U7+IKkMGY+7Y4
gmB5Q1n7f0ClfeHl2MeoQI5BPFCJoDEatZcr0WW7u2p7WuxN7q4q+uNv+lMNcfZa
LY2HKoe0aPEMUoLw9gA9b/KSOQKBgQDBIg2OMELlk4Y+vpv71DopZSx9HGX7/qsn
gu5HHMaQIRK2LjtvjzxMDHA7PSmEnAM9pduOeNZUQYGeTCkJtmH285OrBn1wTvrl
jBxx23z+FRM0ZzdbAXvHFHW9exnqLaCrbFrGgghjjCHttbRuImC83y2Phi30uND9
B+jbosv+DQKBgQCS/o+m9psXSBQNyqhcs/83c2tQ3FN4535Vm/0rkTUL/K7nah55
9KXAJhlkjkaj+E/gN9FHCB5WI6fAbU07I65aazdLrLMaIHacpM/s1LKcVRe3DrT6
Q5s+PDGzf3MIdwkiotdkHnwfpjtsxTY4H4EkWJUukDw48tZF4g2lVfSN0QKBgA2b
4qykRfJ7ZLhDIiaqm7aTBIGEYMNS/Kh6F2Q3aN57FiB0PYfs5ejN75KdCrHndGsB
pujxJtklDIclArdGfLy0CTHB8VDan99Q8igruTEGNyY4J7Rn9Frg3DMP25GeyXWK
2xKl0wWAuFtRtHcWQQ7OAx3b7J0T8NYDmqrvW8R5AoGBAPTMHEtRMMI1HKGpLf84
OXnQBXqDVOW+3BaSWc2ecTh4VG+tGowCZfl6yIvJ6yq7Uj+99boDXj0ZcKUJ91rN
C0QAhp75/e2YlTqfzUXsqxyJlkkXPzq566GLQjd4AlN+Bmnp6ZtcZ+MBvWFcKAk2
KAB+Js9N8swPpiDioycn2Y+o
-----END PRIVATE KEY-----
`

export async function previewTLSFixture(
  handle: (request: IncomingMessage, response: ServerResponse) => void
) {
  const server = createServer({ key, cert: ca }, handle),
    sockets = new Set<Duplex>()
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("TLS fixture address")
  const observed: Array<{
    host: unknown
    servername: unknown
    path: unknown
    headers: unknown
  }> = []
  // Test transport seam changes only the dial endpoint/trusted fixture CA. Production pin/SNI/host identity stays observed.
  const dial: PublicPreviewRequest = (options, listener) => {
    observed.push({
      host: options.host,
      servername: options.servername,
      path: options.path,
      headers: options.headers
    })
    return request({ ...options, host: "127.0.0.1", port: address.port, ca }, listener)
  }
  return {
    dial,
    observed,
    sockets,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
export const publicDNS = async () => [
  { address: "8.8.8.8", family: 4 },
  { address: "2606:4700:4700::1111", family: 6 }
]
