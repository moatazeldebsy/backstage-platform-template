package ${{ values.packageName }}

import org.junit.Assert.assertEquals
import org.junit.Test

class MainActivityTest {

    @Test
    fun greetingText_isCorrect() {
        val expected = "Hello from ${{ values.name }}!"
        val actual = "Hello from ${{ values.name }}!"
        assertEquals(expected, actual)
    }
}
