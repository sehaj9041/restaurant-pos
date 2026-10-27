package com.vishalfoodiez.kiosk;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Build;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Sends raw ESC/POS bytes to a USB receipt printer (class 7, e.g. Bixolon) over a bulk OUT endpoint. */
class UsbPrinter {
    private static final String ACTION_PERMISSION = "com.vishalfoodiez.kiosk.USB_PERMISSION";
    private static final int BIXOLON_VENDOR = 0x1504;

    private final Context ctx;
    private final UsbManager usb;

    UsbPrinter(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        this.usb = (UsbManager) this.ctx.getSystemService(Context.USB_SERVICE);
    }

    UsbDevice findPrinter() {
        for (UsbDevice d : usb.getDeviceList().values()) {
            if (d.getVendorId() == BIXOLON_VENDOR) return d;
            for (int i = 0; i < d.getInterfaceCount(); i++) {
                if (d.getInterface(i).getInterfaceClass() == UsbConstants.USB_CLASS_PRINTER) return d;
            }
        }
        return null;
    }

    String describe() {
        UsbDevice d = findPrinter();
        if (d == null) return "NO_PRINTER";
        return "OK " + d.getProductName() + " (" + Integer.toHexString(d.getVendorId()) + ":" + Integer.toHexString(d.getProductId()) + ")";
    }

    /** Blocking; call off the main thread. Returns "OK" or an error text. */
    volatile String lastInfo = "";

    String send(byte[] data) {
        final long t0 = System.currentTimeMillis();
        UsbDevice dev = findPrinter();
        if (dev == null) return "ERROR: USB printer nahi mila. Cable check karein.";
        if (!usb.hasPermission(dev) && !askPermission(dev)) return "ERROR: USB permission nahi mili.";

        // Prefer the printer-class (7) interface; composite devices may expose other bulk OUT endpoints too.
        UsbInterface iface = null;
        UsbEndpoint out = null;
        for (int pass = 0; pass < 2 && out == null; pass++) {
            for (int i = 0; i < dev.getInterfaceCount() && out == null; i++) {
                UsbInterface c = dev.getInterface(i);
                if (pass == 0 && c.getInterfaceClass() != UsbConstants.USB_CLASS_PRINTER) continue;
                for (int e = 0; e < c.getEndpointCount(); e++) {
                    UsbEndpoint ep = c.getEndpoint(e);
                    if (ep.getType() == UsbConstants.USB_ENDPOINT_XFER_BULK && ep.getDirection() == UsbConstants.USB_DIR_OUT) {
                        iface = c; out = ep; break;
                    }
                }
            }
        }
        if (out == null) return "ERROR: printer ka OUT endpoint nahi mila.";

        String last = "";
        for (int attempt = 0; attempt < 3; attempt++) {
            final long tOpen = System.currentTimeMillis();
            UsbDeviceConnection conn = usb.openDevice(dev);
            if (conn == null) return "ERROR: printer open nahi hua.";
            try {
                if (!conn.claimInterface(iface, true)) return "ERROR: printer interface claim nahi hua.";
                if (iface.getAlternateSetting() != 0) conn.setInterface(iface);
                // This printer (Posiflex PP7900) stalls on big transfers (4096 took 60s+); 1024 works. Fall back to smaller chunks if it stalls.
                int mps = Math.max(64, out.getMaxPacketSize());
                int chunk = attempt == 0 ? 1024 : attempt == 1 ? 512 : mps, off = 0;
                if (chunk < mps) chunk = mps;
                byte[] buf = new byte[chunk];
                boolean failed = false;
                while (off < data.length) {
                    int n = Math.min(chunk, data.length - off);
                    System.arraycopy(data, off, buf, 0, n);
                    int w = -1;
                    // Attempt 0 fails fast (the first transfer after opening this printer often stalls; a reopen fixes it)
                    int maxTries = attempt == 0 ? 1 : 3, timeout = attempt == 0 ? 800 : 3000;
                    for (int tries = 0; tries < maxTries && w < 0; tries++) {
                        w = conn.bulkTransfer(out, buf, n, timeout);
                        if (w < 0 && attempt > 0) { try { Thread.sleep(250); } catch (InterruptedException ignored) {} }
                    }
                    if (w < 0) { last = " (offset " + off + "/" + data.length + ", iface " + iface.getId() + " class " + iface.getInterfaceClass() + ", ep " + out.getAddress() + ", mps " + out.getMaxPacketSize() + ")"; failed = true; break; }
                    off += w;
                }
                conn.releaseInterface(iface);
                if (!failed) {
                    long t1 = System.currentTimeMillis();
                    lastInfo = "DEBUG: " + data.length + " bytes, attempt " + (attempt + 1) + ", chunk " + chunk + ", open+send " + (t1 - tOpen) + "ms, total " + (t1 - t0) + "ms";
                    return "OK";
                }
            } finally {
                conn.close();
            }
            try { Thread.sleep(attempt == 0 ? 100 : 1500); } catch (InterruptedException ignored) {}   // let the printer recover, then reopen
        }
        return "ERROR: print data bhejna fail hua." + last;
    }

    private boolean askPermission(UsbDevice dev) {
        final CountDownLatch latch = new CountDownLatch(1);
        final boolean[] granted = { false };
        BroadcastReceiver r = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                granted[0] = i.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false);
                latch.countDown();
            }
        };
        IntentFilter f = new IntentFilter(ACTION_PERMISSION);
        if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(r, f, Context.RECEIVER_NOT_EXPORTED);
        else ctx.registerReceiver(r, f);
        try {
            Intent intent = new Intent(ACTION_PERMISSION).setPackage(ctx.getPackageName());
            PendingIntent pi = PendingIntent.getBroadcast(ctx, 0, intent, PendingIntent.FLAG_MUTABLE);
            usb.requestPermission(dev, pi);
            latch.await(30, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
        } finally {
            ctx.unregisterReceiver(r);
        }
        return granted[0] && usb.hasPermission(dev);
    }
}
