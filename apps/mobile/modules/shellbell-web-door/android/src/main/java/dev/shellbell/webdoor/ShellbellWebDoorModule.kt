package dev.shellbell.webdoor

// The phone's loopback door moves bytes with backpressure; TypeScript owns HTTP.
// Typed arrays avoid base64. Platform transport AEAD is gated by the shared
// cross-implementation and boundary self-checks.


import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.typedarray.Uint8Array
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.ArrayDeque
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

private const val MAX_SOCKETS = 32
/** Bytes read from a socket and not yet taken by JavaScript; reading pauses above this. */
private const val READ_LIMIT = 64 * 1024
private const val READ_CHUNK = 16 * 1024

private class Connection(val socket: Socket, val generation: Int) {
  val writer: ExecutorService = Executors.newSingleThreadExecutor()
  val queue = ArrayDeque<ByteArray>()
  var queued = 0
  var ended = false
  val lock = Object()
}

class ShellbellWebDoorModule : Module() {
  private var server: ServerSocket? = null
  /** Changes on every listen and stop, so a late event from an old door is ignored in JS. */
  private val generation = AtomicInteger(0)
  private val connections = ConcurrentHashMap<Int, Connection>()
  private val ids = AtomicInteger(1)

  private fun drop(id: Int) {
    val connection = connections.remove(id) ?: return
    try { connection.socket.close() } catch (_: Exception) {}
    connection.writer.shutdownNow()
    synchronized(connection.lock) { connection.lock.notifyAll() }
  }

  private fun stopAll() {
    generation.incrementAndGet()
    try { server?.close() } catch (_: Exception) {}
    server = null
    for (id in connections.keys.toList()) drop(id)
  }

  private fun readLoop(id: Int, connection: Connection) {
    val buffer = ByteArray(READ_CHUNK)
    try {
      val input: InputStream = connection.socket.getInputStream()
      while (true) {
        synchronized(connection.lock) {
          while (connection.queued >= READ_LIMIT && connections[id] === connection) connection.lock.wait()
        }
        if (connections[id] !== connection) return
        val n = input.read(buffer)
        if (n < 0) break
        synchronized(connection.lock) {
          connection.queue.addLast(buffer.copyOf(n))
          connection.queued += n
        }
        sendEvent("readable", mapOf("id" to id, "generation" to connection.generation))
      }
      synchronized(connection.lock) { connection.ended = true }
      sendEvent("readable", mapOf("id" to id, "generation" to connection.generation))
    } catch (e: Exception) {
      if (connections[id] === connection)
        sendEvent("closed", mapOf("id" to id, "generation" to connection.generation))
    }
  }

  private fun cipher(mode: Int, key: Uint8Array, nonce: Uint8Array, ad: Uint8Array): Cipher {
    require(key.byteLength == 32 && nonce.byteLength == 12)
    val k = ByteArray(32).also { key.read(it, 0, 32) }
    val n = ByteArray(12).also { nonce.read(it, 0, 12) }
    val cipher = Cipher.getInstance("ChaCha20-Poly1305")
    cipher.init(mode, SecretKeySpec(k, "ChaCha20"), IvParameterSpec(n))
    k.fill(0)
    if (ad.byteLength > 0) cipher.updateAAD(ad.toDirectBuffer())
    return cipher
  }

  override fun definition() = ModuleDefinition {
    Name("ShellbellWebDoor")
    Events("accepted", "readable", "written", "closed")

    // Listens on 127.0.0.1 at a free port. Returns [port, generation].
    Function("listen") {
      stopAll()
      val s = ServerSocket()
      s.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 16)
      server = s
      val current = generation.get()
      Thread {
        try {
          while (!s.isClosed) {
            val socket = s.accept()
            if (connections.size >= MAX_SOCKETS || generation.get() != current) {
              socket.close()
              continue
            }
            socket.tcpNoDelay = true
            val id = ids.getAndIncrement()
            val connection = Connection(socket, current)
            connections[id] = connection
            sendEvent("accepted", mapOf("id" to id, "generation" to current))
            Thread { readLoop(id, connection) }.apply { name = "web-door-$id"; isDaemon = true }.start()
          }
        } catch (_: Exception) {}
      }.apply { name = "web-door-accept"; isDaemon = true }.start()
      listOf(s.localPort, current)
    }

    Function("stop") { stopAll() }

    // Moves up to out.byteLength queued bytes into `out`. Returns the count, 0 when nothing is
    // queued yet, or -1 once the socket has ended and everything has been read.
    Function("read") { id: Int, out: Uint8Array ->
      val connection = connections[id] ?: return@Function -1
      var copied = 0
      synchronized(connection.lock) {
        while (copied < out.byteLength) {
          val head = connection.queue.peekFirst() ?: break
          val n = minOf(head.size, out.byteLength - copied)
          out.write(head, copied, n)
          copied += n
          connection.queue.removeFirst()
          if (n < head.size) connection.queue.addFirst(head.copyOfRange(n, head.size))
        }
        connection.queued -= copied
        connection.lock.notifyAll()
        if (copied == 0 && connection.ended) return@Function -1
      }
      copied
    }

    // Writes bytes in order; `written` reports them once the socket took them.
    Function("write") { id: Int, data: Uint8Array ->
      val connection = connections[id] ?: return@Function false
      val bytes = ByteArray(data.byteLength).also { data.read(it, 0, it.size) }
      connection.writer.execute {
        try {
          connection.socket.getOutputStream().apply { write(bytes); flush() }
          sendEvent("written", mapOf("id" to id, "generation" to connection.generation, "bytes" to bytes.size))
        } catch (_: Exception) {
          if (connections[id] === connection)
            sendEvent("closed", mapOf("id" to id, "generation" to connection.generation))
        }
      }
      true
    }

    Function("shutdownOutput") { id: Int ->
      val connection = connections[id] ?: return@Function
      connection.writer.execute { try { connection.socket.shutdownOutput() } catch (_: Exception) {} }
    }

    // Closes after any queued writes.
    Function("close") { id: Int ->
      val connection = connections[id] ?: return@Function
      try { connection.writer.execute { drop(id) } } catch (_: Exception) { drop(id) }
    }

    // The throwaway page view: storage, cookies and cache, at every open and close.
    AsyncFunction("clearWebData") { promise: Promise ->
      val context = appContext.reactContext ?: return@AsyncFunction promise.resolve(false)
      Handler(Looper.getMainLooper()).post {
        try {
          WebStorage.getInstance().deleteAllData()
          WebView(context).apply { clearCache(true); destroy() }
          val cookies = CookieManager.getInstance()
          cookies.removeAllCookies {
            cookies.flush()
            promise.resolve(true)
          }
        } catch (e: Exception) {
          promise.reject("ERR_WEB_CLEAR", e.message ?: "clear failed", e)
        }
      }
    }

    // ChaCha20-Poly1305 for transport frames (Android 9+). `out` must be exactly the result size.
    Function("aeadSeal") { key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, input: Uint8Array, out: Uint8Array ->
      require(out.byteLength == input.byteLength + 16)
      require(input.byteLength <= 65519)
      val written = cipher(Cipher.ENCRYPT_MODE, key, nonce, ad).doFinal(input.toDirectBuffer(), out.toDirectBuffer())
      check(written == out.byteLength)
    }

    // Returns the plaintext length, or -1 when the tag doesn't verify.
    Function("aeadOpen") { key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, input: Uint8Array, out: Uint8Array ->
      require(input.byteLength >= 16 && out.byteLength == input.byteLength - 16)
      TransportPlaintext.open(cipher(Cipher.DECRYPT_MODE, key, nonce, ad), input.toDirectBuffer(), out.toDirectBuffer())
    }

    OnDestroy { stopAll() }
  }
}
