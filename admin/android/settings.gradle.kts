// ---------------------------------------------------------------------------
// Nix read-only store workarounds
// ---------------------------------------------------------------------------
// Both the Flutter SDK and Android SDK may live in /nix/store (read-only).
// The Flutter Gradle plugin requires bin/cache/engine.realm (missing from
// the Nix derivation), and AGP auto-installs missing SDK components (NDK,
// platforms) which fails on a read-only directory.  We create writable
// overlay directories that symlink the originals and let Gradle write to them.
// ---------------------------------------------------------------------------

// Create a two-level overlay: top-level entries that are directories become
// real writable directories with their children symlinked; top-level files
// are symlinked directly.  This lets the SDK manager create new subdirectories
// (e.g. build-tools/35.0.0) alongside the existing Nix store entries.
fun createNixOverlay(originalDir: java.io.File, overlayDir: java.io.File) {
    overlayDir.deleteRecursively()
    overlayDir.mkdirs()
    originalDir.listFiles()?.forEach { entry ->
        val target = overlayDir.toPath().resolve(entry.name)
        if (entry.isDirectory && !java.nio.file.Files.isSymbolicLink(entry.toPath())) {
            // Real directory: create writable copy with symlinked children
            target.toFile().mkdirs()
            entry.listFiles()?.forEach { child ->
                java.nio.file.Files.createSymbolicLink(
                    target.resolve(child.name), child.toPath()
                )
            }
        } else {
            // File or symlink: symlink directly
            java.nio.file.Files.createSymbolicLink(target, entry.toPath())
        }
    }
}

pluginManagement {
    val flutterSdkPath =
        run {
            val properties = java.util.Properties()
            file("local.properties").inputStream().use { properties.load(it) }
            val originalSdkPath = properties.getProperty("flutter.sdk")
            require(originalSdkPath != null) { "flutter.sdk not set in local.properties" }

            val sdkDir = java.io.File(originalSdkPath)
            val realmFile = java.io.File(sdkDir, "bin/cache/engine.realm")
            if (realmFile.exists() && sdkDir.canWrite()) return@run originalSdkPath

            val projectRoot = rootDir.parentFile
            val overlay = java.io.File(projectRoot, ".dev/flutter-sdk")
            val overlayRealm = java.io.File(overlay, "bin/cache/engine.realm")

            if (!overlayRealm.exists()) {
                overlay.deleteRecursively()
                overlay.mkdirs()
                sdkDir.listFiles()?.filter { it.name != "bin" }?.forEach {
                    java.nio.file.Files.createSymbolicLink(
                        overlay.toPath().resolve(it.name), it.toPath()
                    )
                }
                java.io.File(overlay, "bin").mkdirs()
                java.io.File(sdkDir, "bin").listFiles()?.filter { it.name != "cache" }?.forEach {
                    java.nio.file.Files.createSymbolicLink(
                        java.io.File(overlay, "bin").toPath().resolve(it.name), it.toPath()
                    )
                }
                java.io.File(overlay, "bin/cache").mkdirs()
                java.io.File(sdkDir, "bin/cache").listFiles()?.forEach {
                    java.nio.file.Files.createSymbolicLink(
                        java.io.File(overlay, "bin/cache").toPath().resolve(it.name), it.toPath()
                    )
                }
                overlayRealm.writeText("")
            }

            val lpFile = file("local.properties")
            lpFile.writeText(
                lpFile.readText().replace(
                    "flutter.sdk=$originalSdkPath",
                    "flutter.sdk=${overlay.absolutePath}"
                )
            )
            overlay.absolutePath
        }

    includeBuild("$flutterSdkPath/packages/flutter_tools/gradle")

    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "8.11.1" apply false
    id("org.jetbrains.kotlin.android") version "2.2.20" apply false
}

include(":app")

// Android SDK overlay: if sdk.dir points to a read-only directory, create
// a writable overlay so AGP can auto-install missing components (NDK, platforms).
// Also override AAPT2: AGP downloads its own AAPT2 binary from Maven which uses
// /lib64/ld-linux-x86-64.so.2 as interpreter — that path doesn't exist on NixOS.
// The Nix-provided build-tools have a properly patchelf'd AAPT2.
run {
    val lpFile = file("local.properties")
    val properties = java.util.Properties()
    lpFile.inputStream().use { properties.load(it) }
    val sdkDirPath = properties.getProperty("sdk.dir") ?: return@run
    val sdkDir = java.io.File(sdkDirPath)

    if (sdkDir.canWrite()) return@run

    val projectRoot = rootDir.parentFile
    val overlay = java.io.File(projectRoot, ".dev/android-sdk")
    if (!overlay.exists()) {
        createNixOverlay(sdkDir, overlay)
    }

    // Rewrite local.properties so AGP uses the writable overlay
    lpFile.writeText(
        lpFile.readText().replace(
            "sdk.dir=$sdkDirPath",
            "sdk.dir=${overlay.absolutePath}"
        )
    )

    // Find the Nix-provided AAPT2 (patchelf'd for NixOS) and override AGP's
    // Maven-downloaded one which has a hardcoded /lib64 interpreter.
    val buildToolsDir = java.io.File(sdkDir, "build-tools")
    val nixAapt2 = buildToolsDir.listFiles()
        ?.sortedDescending()
        ?.map { java.io.File(it, "aapt2") }
        ?.firstOrNull { it.exists() }
    if (nixAapt2 != null) {
        val gpFile = file("gradle.properties")
        val gpText = if (gpFile.exists()) gpFile.readText() else ""
        if (!gpText.contains("android.aapt2FromMavenOverride")) {
            gpFile.appendText(
                "\n# Auto-set by settings.gradle.kts for NixOS compatibility\n" +
                "android.aapt2FromMavenOverride=${nixAapt2.absolutePath}\n"
            )
        }
    }
}
