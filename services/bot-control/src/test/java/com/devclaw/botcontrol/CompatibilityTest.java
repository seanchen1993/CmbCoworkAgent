package com.devclaw.botcontrol;
import org.junit.jupiter.api.Test;
class CompatibilityTest {
    @Test void strictJsonAndPrecision() throws Exception { CompatibilityProbe.jsonCompatibility(); }
    @Test void draft202012AndExplicitFormat() throws Exception { CompatibilityProbe.schemaCompatibility(); }
    @Test void oneModernLoggingProvider() throws Exception { CompatibilityProbe.loggingCompatibility(); }
    @Test void bootWithoutWebOrDatabase() { CompatibilityProbe.bootCompatibility(); }
}
