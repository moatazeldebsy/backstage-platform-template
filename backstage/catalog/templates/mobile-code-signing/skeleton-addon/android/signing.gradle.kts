// Android release signing configuration
// Keystore is provisioned at CI time from AWS Secrets Manager.
// Never commit the keystore file or passwords to the repository.
//
// Required environment variables (set as GitHub secrets):
//   KEYSTORE_STORE_PASSWORD  — store password
//   KEYSTORE_KEY_ALIAS       — key alias
//   KEYSTORE_KEY_PASSWORD    — key password
//   KEYSTORE_FILE            — base64-encoded keystore (written to disk by CI)

import java.util.Base64
import java.io.FileOutputStream

val keystoreFile = rootProject.file("app/release.keystore")

android {
    signingConfigs {
        create("release") {
            val storePasswordEnv = System.getenv("KEYSTORE_STORE_PASSWORD")
            val keyAliasEnv     = System.getenv("KEYSTORE_KEY_ALIAS")
            val keyPasswordEnv  = System.getenv("KEYSTORE_KEY_PASSWORD")

            if (storePasswordEnv != null && keyAliasEnv != null && keyPasswordEnv != null && keystoreFile.exists()) {
                storeFile     = keystoreFile
                storePassword = storePasswordEnv
                keyAlias      = keyAliasEnv
                keyPassword   = keyPasswordEnv
            } else {
                println("WARNING: Release signing config not fully set — unsigned build will be produced.")
            }
        }
    }

    buildTypes {
        getByName("release") {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled     = true
            isShrinkResources   = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
}
