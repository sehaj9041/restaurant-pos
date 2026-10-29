package com.vishalfoodiez.kds;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** TV restart hone par KDS app apne aap khul jaye (kuch TVs par "display over other apps" permission chahiye). */
public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent i) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(i.getAction())) {
            Intent launch = new Intent(c, MainActivity.class);
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(launch);
        }
    }
}
