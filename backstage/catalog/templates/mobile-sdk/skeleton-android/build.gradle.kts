{% if values.platform === 'android' or values.platform === 'multiplatform' %}
plugins {
    kotlin("jvm") version "2.0.21"
    `maven-publish`
}

group = "com.github.${{ values.githubOrg }}"
version = project.findProperty("version") as String? ?: "0.1.0"

repositories {
    mavenCentral()
}

dependencies {
    implementation(kotlin("stdlib"))
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.0")
}

tasks.test {
    useJUnitPlatform()
}

publishing {
    publications {
        create<MavenPublication>("gpr") {
            from(components["java"])
            groupId    = "com.github.${{ values.githubOrg }}"
            artifactId = "${{ values.name }}"
            version    = project.version as String
        }
    }
    repositories {
        maven {
            name = "GitHubPackages"
            url  = uri("https://maven.pkg.github.com/${{ values.githubOrg }}/${{ values.name }}")
            credentials {
                username = System.getenv("GITHUB_ACTOR")
                password = System.getenv("GITHUB_TOKEN")
            }
        }
    }
}
{% endif %}
