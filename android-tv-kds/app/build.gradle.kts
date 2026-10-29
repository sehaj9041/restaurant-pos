plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "com.vishalfoodiez.kds"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "com.vishalfoodiez.kds"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}
