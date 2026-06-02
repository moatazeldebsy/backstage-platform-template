{% if values.platform === 'ios' %}
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "${{ values.name | replace('-', '_') }}",
    platforms: [
        .iOS(.v16),
        .macOS(.v13),
    ],
    products: [
        .library(
            name: "${{ values.name | replace('-', '_') }}",
            targets: ["${{ values.name | replace('-', '_') }}"]
        ),
    ],
    dependencies: [],
    targets: [
        .target(
            name: "${{ values.name | replace('-', '_') }}",
            dependencies: [],
            path: "Sources/${{ values.name | replace('-', '_') }}"
        ),
        .testTarget(
            name: "${{ values.name | replace('-', '_') }}Tests",
            dependencies: ["${{ values.name | replace('-', '_') }}"],
            path: "Tests/${{ values.name | replace('-', '_') }}Tests"
        ),
    ]
)
{% endif %}
