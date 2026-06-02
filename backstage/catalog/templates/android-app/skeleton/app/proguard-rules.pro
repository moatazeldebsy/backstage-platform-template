# Add project-specific ProGuard rules here.
# By default, the flags in this file are applied to release builds.
# https://developer.android.com/build/shrink-code

# Preserve Kotlin metadata for reflection
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt

# Keep Compose-related classes
-keep class androidx.compose.** { *; }
